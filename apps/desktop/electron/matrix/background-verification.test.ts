import { describe, expect, it } from 'vitest'

import type { MatrixVerification } from '../../shared/matrix-security'

import {
  matrixBackgroundVerificationMatch,
  MatrixBackgroundVerifications,
  MatrixLaunchSummary
} from './background-verification'

const AGENT = { userId: '@moon:test', deviceId: 'MOONDEVICE' }

const request = (extra: Partial<MatrixVerification> = {}): MatrixVerification => ({
  id: 'main-1',
  userId: AGENT.userId,
  deviceId: AGENT.deviceId,
  incoming: false,
  state: 'requested',
  ...extra
})

const STATES: MatrixVerification['state'][] = ['requested', 'ready', 'started', 'compare', 'done', 'cancelled']

describe('main’s own agent check never reaches the window', () => {
  it('hides its request in every state, symbols included, and keeps its end hidden after the check', () => {
    const lines: string[] = []

    const quiet = new MatrixBackgroundVerifications(
      line => lines.push(line),
      () => 1_000
    )

    quiet.begin(AGENT, 'agentmoo', undefined)
    // Before the agent accepts, the SDK leaves the device empty.
    expect(quiet.view(request({ deviceId: '' }))).toBeUndefined()
    quiet.confirm()

    for (const state of STATES.slice(1, 4)) {
      expect(quiet.view(request({ state }))).toBeUndefined()
    }

    expect(
      quiet.view(
        request({
          state: 'compare',
          decimals: [1111, 2222, 3333],
          emoji: Array.from({ length: 7 }, (_, at) => ['🐶', `Dog ${at}`] as [string, string])
        })
      )
    ).toBeUndefined()

    quiet.end()
    // The check is over: its cancel stays hidden, and is logged once with its closed code only.
    expect(quiet.view(request({ state: 'cancelled', cancelCode: 'm.user' }))).toBeUndefined()
    expect(quiet.view(request({ state: 'cancelled', cancelCode: 'm.user' }))).toBeUndefined()
    expect(quiet.hidden('main-1')).toBe(true)
    expect(lines).toEqual(['[Matrix] agent agentmoo trust handshake=background state=cancelled code=m.user ms=0'])
  })

  it('never hides a request someone else started, even from the agent’s own account', () => {
    const quiet = new MatrixBackgroundVerifications()
    quiet.begin(AGENT, 'agentmoo', undefined)

    const incoming = request({ id: 'theirs', incoming: true, state: 'compare' })
    expect(quiet.view(incoming)).toEqual(incoming)
    expect(quiet.hidden('theirs')).toBe(false)
  })

  it('never hides the person’s own request to another device of that account, or to anyone else', () => {
    const quiet = new MatrixBackgroundVerifications()
    quiet.begin(AGENT, 'agentmoo', undefined)
    quiet.confirm()

    const otherDevice = request({ id: 'person-1', deviceId: 'OTHERDEVICE', state: 'ready' })
    const someone = request({ id: 'person-2', userId: '@linh:test', deviceId: 'LINH', state: 'compare' })
    expect(quiet.view(otherDevice)).toEqual(otherDevice)
    expect(quiet.view(someone)).toEqual(someone)
    expect(matrixBackgroundVerificationMatch(someone, AGENT)).toBe(false)
  })

  it('shows everything when no check runs: the account alone is never enough', () => {
    const quiet = new MatrixBackgroundVerifications()
    const toAgent = request({ id: 'person-3', deviceId: '' })
    expect(quiet.view(toAgent)).toEqual(toAgent)
    expect(matrixBackgroundVerificationMatch(toAgent, undefined)).toBe(false)
  })

  it('leaves the person’s request on screen when it was there first, or when it won the start', () => {
    const quiet = new MatrixBackgroundVerifications()
    const theirs = request({ id: 'person-4', state: 'ready' })

    // Already pending when the check began: the person's.
    quiet.begin(AGENT, 'agentmoo', theirs)
    expect(quiet.view(theirs)).toEqual(theirs)

    // Seen during main's start, which the SDK then refused: the person's after all.
    const raced = request({ id: 'person-5', deviceId: '' })
    quiet.begin(AGENT, 'agentmoo', undefined)
    expect(quiet.view(raced)).toBeUndefined()
    quiet.abandon()
    expect(quiet.hidden('person-5')).toBe(false)
    expect(quiet.view(raced)).toEqual(raced)
  })

  it('counts a request from elsewhere that the check’s own device cancelled', () => {
    const lines: string[] = []
    const quiet = new MatrixBackgroundVerifications(line => lines.push(line))
    quiet.begin(AGENT, 'agentmoo', undefined)
    const element = request({ id: 'element-x', userId: '@owner:test', deviceId: 'PHONE', incoming: true })
    quiet.view(element)
    quiet.view({ ...element, state: 'cancelled' })
    quiet.view({ ...element, state: 'cancelled' })
    expect(lines).toEqual(['[Matrix] security incoming verification cancelled during background handshake'])
  })
})

describe('the launch, in one log line instead of on screen', () => {
  const agents = (...phases: string[]) =>
    phases.map(phase =>
      phase === 'reconnecting'
        ? { readiness: { phase: 'blocked', code: 'agent_reconnecting' } }
        : { readiness: { phase } }
    )

  it('sums the launch up once, when every agent has settled', () => {
    const lines: string[] = []
    let now = 1_000

    const summary = new MatrixLaunchSummary(
      line => lines.push(line),
      () => now
    )

    summary.observe(undefined)
    summary.observe(agents('starting', 'ready', 'ready'))
    summary.trusted('cross_signed')
    summary.trusted('cross_signed')
    summary.trusted('verified')
    now = 9_000
    summary.observe(agents('ready', 'reconnecting', 'ready'))
    expect(lines).toEqual([])

    now = 26_000
    summary.observe(agents('ready', 'ready', 'blocked'))
    summary.observe(agents('ready', 'ready', 'ready'))
    expect(lines).toEqual([
      '[Matrix] launch quiet agents=3 ready=2 cross_signed=2 verified=1 failed=0 reconnecting=0 ms=25000'
    ])
  })

  it('sums up a launch that never settles at two minutes', () => {
    const lines: string[] = []
    let now = 0

    const summary = new MatrixLaunchSummary(
      line => lines.push(line),
      () => now
    )

    summary.observe(agents('starting', 'ready'))
    summary.trusted('failed')
    now = 120_000
    summary.observe(agents('starting', 'ready'))
    expect(lines).toEqual([
      '[Matrix] launch quiet agents=2 ready=1 cross_signed=0 verified=0 failed=1 reconnecting=0 ms=120000'
    ])
  })
})
