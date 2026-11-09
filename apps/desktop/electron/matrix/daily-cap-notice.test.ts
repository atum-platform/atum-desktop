import { describe, expect, it, vi } from 'vitest'

import { matrixDailyCapNoticeRunId } from '../../shared/daily-cap-notice'
import type { MatrixSdkCommand } from '../../shared/matrix'

import { MatrixDailyCapNotices } from './daily-cap-notice'

const agent = '11111111-1111-4111-8111-111111111111'
const agentUser = '@agent:test'
const noticeKey = `daily-cap-notice:${agent}:2026-10-21:eighty_percent`
const profile = 'atum.daily-cap-notice/1'
const room = '!main:test'

function harness(options: {
  claim?: unknown
  commands?: (command: MatrixSdkCommand) => unknown
  room?: string | null
} = {}) {
  const calls: Array<Record<string, unknown>> = []
  const commands: MatrixSdkCommand[] = []
  const notice = new MatrixDailyCapNotices({
    claim: vi.fn(async (_agent, input) => {
      calls.push(input)
      return input.operation === 'claim' ? options.claim ?? { profile, state: 'none' } : { profile, state: 'published' }
    }),
    mainRoom: () => options.room === null ? undefined : options.room ?? '!main:test',
    agentUserId: () => agentUser,
    command: async (_agent, command) => {
      commands.push(command)
      return options.commands ? options.commands(command) : command.kind === 'findTurn'
        ? { state: 'absent' } : command.kind === 'publishCron' ? '$event:test' : {}
    },
    requireRoom: async () => {},
    locale: () => 'en',
    log: () => {}
  })
  return { calls, commands, notice }
}

describe('Mac daily-cap notice delivery', () => {
  it('posts one quiet notice into the main room and acknowledges the event', async () => {
    const h = harness({ claim: { profile, state: 'claim', noticeKey, kind: 'eighty_percent', day: '2026-10-21' } })
    await h.notice.check({ agentPrincipal: agent })
    expect(h.commands.find(command => command.kind === 'publishCron')).toMatchObject({
      kind: 'publishCron', roomId: '!main:test', runId: matrixDailyCapNoticeRunId(noticeKey),
      jobId: 'daily-cap-warning', notify: false,
      body: 'I’m close to today’s usage limit. I’ll keep going as usual; this is just a heads-up.'
    })
    expect(h.calls.map(call => call.operation)).toEqual(['claim', 'published'])
    expect(h.calls[1]).toMatchObject({ noticeKey, publishedEvent: '$event:test' })
  })

  it('acknowledges an event already read back without sending a second one', async () => {
    const h = harness({
      claim: { profile, state: 'claim', noticeKey, kind: 'eighty_percent', day: '2026-10-21' },
      commands: command => command.kind === 'findTurn' ? { state: 'found', eventId: '$already:test' } : {}
    })
    await h.notice.check({ agentPrincipal: agent })
    expect(h.commands.some(command => command.kind === 'publishCron')).toBe(false)
    expect(h.calls[1]).toMatchObject({ operation: 'published', publishedEvent: '$already:test' })
  })

  it('sends nothing for none, held, unknown read-back or a missing main room', async () => {
    for (const claim of [{ profile, state: 'none' }, { profile, state: 'held' }]) {
      const h = harness({ claim })
      await h.notice.check({ agentPrincipal: agent })
      expect(h.commands).toEqual([])
    }
    const unknown = harness({
      claim: { profile, state: 'claim', noticeKey, kind: 'eighty_percent', day: '2026-10-21' },
      commands: command => command.kind === 'findTurn' ? { state: 'unknown' } : {}
    })
    await unknown.notice.check({ agentPrincipal: agent })
    expect(unknown.commands.some(command => command.kind === 'publishCron')).toBe(false)
    const noRoom = harness({
      claim: { profile, state: 'claim', noticeKey, kind: 'eighty_percent', day: '2026-10-21' },
      room: null
    })
    await noRoom.notice.check({ agentPrincipal: agent })
    expect(noRoom.commands).toEqual([])
  })

  it('does not acknowledge an unconfirmed send', async () => {
    const h = harness({
      claim: { profile, state: 'claim', noticeKey, kind: 'eighty_percent', day: '2026-10-21' },
      commands: command => command.kind === 'findTurn' ? { state: 'absent' } : command.kind === 'publishCron' ? undefined : {}
    })
    await h.notice.check({ agentPrincipal: agent })
    expect(h.calls.map(call => call.operation)).toEqual(['claim'])
  })

  it('checks at most once per interval for an agent', async () => {
    const h = harness()
    await h.notice.check({ agentPrincipal: agent })
    await h.notice.check({ agentPrincipal: agent })
    expect(h.calls).toHaveLength(1)
  })
})

interface SentEvent {
  eventId: string
  device: string
  roomId: string
  runId: string
  sender: string
  redacted: boolean
  landed: boolean
}

/** A Matrix server per device: transaction ids are scoped to their device, and a delayed send
 * can be acknowledged before it becomes visible in the room. */
class FakeMatrix {
  readonly visible: SentEvent[] = []
  readonly events = new Map<string, SentEvent>()
  readonly sent: SentEvent[] = []
  readonly redactions: string[] = []
  private readonly transactions = new Map<string, Map<string, string>>()
  private readonly delayed = new Set<string>()
  private sequence = 0

  delay(device: string): void {
    this.delayed.add(device)
  }

  land(device: string): void {
    for (const event of this.events.values()) {
      if (event.device === device && !event.landed) {
        event.landed = true
        this.visible.push(event)
      }
    }
  }

  handle(device: string, command: MatrixSdkCommand): unknown {
    switch (command.kind) {
      case 'findTurn': {
        const found = [...this.visible].reverse().find(event =>
          event.runId === command.turnId && event.sender === command.sender &&
          event.roomId === command.roomId && !event.redacted)
        return found ? { state: 'found', eventId: found.eventId } : { state: 'absent' }
      }
      case 'publishCron': {
        const transactions = this.transactions.get(device) ?? new Map<string, string>()
        this.transactions.set(device, transactions)
        const key = `cron:${command.runId}`
        const prior = transactions.get(key)
        if (prior) {return prior}
        const eventId = `$${device}-${++this.sequence}:test`
        const event: SentEvent = {
          eventId, device, roomId: command.roomId, runId: command.runId, sender: agentUser,
          redacted: false, landed: !this.delayed.has(device)
        }
        transactions.set(key, eventId)
        this.events.set(eventId, event)
        this.sent.push(event)
        if (event.landed) {this.visible.push(event)}
        return eventId
      }
      case 'redact':
        this.redactions.push(command.eventId)
        return null
      default:
        return {}
    }
  }
}

/** The 0270 reservation: only the first atomic insert grants a send. A same-token replay, a
 * rival, a delivered or superseded row never grants another one; there is no lease takeover. */
class FakeRow {
  state: 'claimed' | 'delivered' | 'superseded' | null = null
  token: string | null = null
  event: string | null = null
  readonly claims: string[] = []

  call(input: Record<string, unknown>): unknown {
    if (input.operation === 'claim') {
      const token = String(input.claimToken)
      this.claims.push(token)
      if (this.state === null) {
        this.state = 'claimed'
        this.token = token
        return { profile, state: 'claim', noticeKey, kind: 'eighty_percent', day: '2026-10-21' }
      }
      if (this.state === 'claimed' && this.token !== token) {return { profile, state: 'held' }}
      return { profile, state: 'none' }
    }
    if (this.token !== input.claimToken) {throw Error('matrix_daily_cap_notice_unavailable')}
    const event = String(input.publishedEvent)
    if (this.state === 'delivered') {
      if (this.event !== event) {throw Error('matrix_daily_cap_notice_unavailable')}
      return { profile, state: 'published' }
    }
    this.state = 'delivered'
    this.event = event
    return { profile, state: 'published' }
  }
}

class FakePlatform {
  readonly row = new FakeRow()
  readonly acks: string[] = []
  private readonly gates = new Map<string, Promise<void>>()
  private readonly failures = new Map<string, Error>()

  holdAck(device: string): { release: () => void } {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    this.gates.set(device, gate)
    return { release: () => { this.gates.delete(device); release() } }
  }

  failNextAck(device: string, error: Error): void {
    this.failures.set(device, error)
  }

  async call(device: string, input: Record<string, unknown>): Promise<unknown> {
    if (input.operation === 'published') {
      this.acks.push(device)
      const failure = this.failures.get(device)
      if (failure) {
        this.failures.delete(device)
        throw failure
      }
      const gate = this.gates.get(device)
      if (gate) {
        this.gates.delete(device)
        await gate
      }
    }
    return this.row.call(input)
  }
}

function runtime(device: string, matrix: FakeMatrix, platform: FakePlatform, failPublish = false) {
  const commands: MatrixSdkCommand[] = []
  const logs: string[] = []
  const notice = new MatrixDailyCapNotices({
    claim: (_principal, input) => platform.call(device, input),
    mainRoom: () => room,
    agentUserId: () => agentUser,
    command: async (_agent, command) => {
      commands.push(command)
      if (failPublish && command.kind === 'publishCron') {throw Error('matrix_daily_cap_notice_unavailable')}
      return matrix.handle(device, command)
    },
    requireRoom: async () => {},
    locale: () => 'en',
    log: line => logs.push(line)
  })
  return { notice, commands, logs }
}

describe('Mac daily-cap notice with one platform reservation', () => {
  it('never grants or publishes a second event when another device already reserved the day', async () => {
    const matrix = new FakeMatrix()
    const platform = new FakePlatform()
    const a = runtime('a', matrix, platform)
    const b = runtime('b', matrix, platform)
    matrix.delay('a')
    const gate = platform.holdAck('a')

    const aRun = a.notice.check({ agentPrincipal: agent })
    await vi.waitFor(() => expect(platform.acks).toContain('a'))
    const aEvent = matrix.sent.find(event => event.device === 'a')!
    expect(matrix.visible).toEqual([])

    await b.notice.check({ agentPrincipal: agent })
    expect(platform.row.state).toBe('claimed')
    expect(b.commands.some(command => command.kind === 'publishCron')).toBe(false)
    expect(matrix.sent.filter(event => event.device === 'b')).toEqual([])

    gate.release()
    await aRun
    matrix.land('a')
    expect(matrix.visible.filter(event => !event.redacted).map(event => event.eventId)).toEqual([aEvent.eventId])
    expect(matrix.redactions).toEqual([])
  })

  it('does not let a rival publish after a lost acknowledgement, and never redacts', async () => {
    const matrix = new FakeMatrix()
    const platform = new FakePlatform()
    const a = runtime('a', matrix, platform)
    const b = runtime('b', matrix, platform)
    platform.failNextAck('a', Error('matrix_daily_cap_notice_unavailable'))

    await a.notice.check({ agentPrincipal: agent })
    const aEvent = matrix.sent.find(event => event.device === 'a')!
    await b.notice.check({ agentPrincipal: agent })

    expect(platform.row.state).toBe('claimed')
    expect(b.commands.some(command => command.kind === 'publishCron')).toBe(false)
    expect(matrix.redactions).toEqual([])
    expect(matrix.visible.filter(event => !event.redacted).map(event => event.eventId)).toEqual([aEvent.eventId])
  })

  it('treats a crash before posting as a missed notice, never a new send', async () => {
    const matrix = new FakeMatrix()
    const platform = new FakePlatform()
    const a = runtime('a', matrix, platform, true)
    const b = runtime('b', matrix, platform)

    await a.notice.check({ agentPrincipal: agent })
    await b.notice.check({ agentPrincipal: agent })

    expect(platform.row.state).toBe('claimed')
    expect(matrix.sent).toEqual([])
    expect(b.commands.some(command => command.kind === 'publishCron')).toBe(false)
  })
})
