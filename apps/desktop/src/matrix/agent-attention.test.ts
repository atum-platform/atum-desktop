import { describe, expect, it, vi } from 'vitest'

import { MATRIX_READINESS_TIMINGS, MatrixReadinessMonitor } from '../../electron/matrix/readiness'
import type { MatrixAgentView, MatrixReadiness, MatrixSnapshot } from '../../shared/matrix'

import {
  MATRIX_GATE_GRACE_MS,
  MATRIX_SLOW_START_MS,
  MATRIX_TRUST_GRACE_MS,
  MATRIX_UNKNOWN_GRACE_MS,
  matrixAgentAttention,
  matrixAttentionItems,
  matrixAttentionWakeAt
} from './agent-attention'

const NOW = 1_000_000

const agent = (principal: string, extra: Partial<MatrixAgentView> = {}): MatrixAgentView => ({
  principal,
  userId: `@${principal}:test`,
  isDefault: principal === 'atum',
  ready: true,
  hermes: 'ready',
  readiness: { phase: 'ready', since: NOW - 60_000 },
  atumModel: true,
  ...extra
})

const blocked = (code: string, ago = 60_000): MatrixAgentView['readiness'] => ({
  phase: 'blocked',
  step: 'assistant',
  code,
  since: NOW - ago
})

const snapshot = (agents: MatrixAgentView[], extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot => ({
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'MAC' },
  rooms: [],
  roomId: null,
  messages: [],
  error: null,
  agents,
  ...extra
})

describe('one agent’s attention', () => {
  it.each([
    ['recovery_required', 'not_running', 'recovery'],
    ['device_replaced', 'not_running', 'device_damaged'],
    ['sign_in_required', 'not_running', 'sign_in'],
    ['out_of_protons', 'not_running', 'protons'],
    ['runtime_invalid', 'not_running', 'runtime'],
    ['action_required', 'not_running', 'connect'],
    ['agent_reconnect_required', 'needs_you', undefined],
    ['authority_withdrawn', 'needs_you', undefined],
    ['setup_failed', 'needs_you', undefined],
    ['plan_sign_in', 'needs_you', undefined],
    ['agent_trust_failed', 'needs_you', undefined],
    ['something_new', 'needs_you', undefined],
    ['offline', 'not_running', undefined],
    ['ai_unavailable', 'not_running', undefined],
    ['agent_reconnecting', 'not_running', undefined],
    ['agent_initializing', 'not_running', undefined]
  ] as const)('%s, long after it began: %s, waiting on %s', (code, state, waitsOn) => {
    const attention = matrixAgentAttention(agent('moon', { readiness: blocked(code, 10 * 60_000) }), NOW)

    expect(attention.state).toBe(state)
    expect(attention.waitsOn).toBe(waitsOn)
    // Its own chat always has a word for a block that lasted.
    expect(attention.chatLine).toBe(true)
  })

  it('never asks for the person while a launch settles, except for what is final by nature', () => {
    for (const code of ['something_new', 'agent_trust_failed', 'offline', 'ai_unavailable']) {
      const attention = matrixAgentAttention(agent('moon', { readiness: blocked(code, 1_000) }), NOW)
      expect(attention).toMatchObject({ state: 'not_running' })
      expect(attention.chatLine).toBeUndefined()
      expect(attention.wakeAt).toBeGreaterThan(NOW)
    }

    for (const code of ['agent_reconnect_required', 'authority_withdrawn', 'setup_failed', 'plan_sign_in']) {
      expect(matrixAgentAttention(agent('moon', { readiness: blocked(code, 0) }), NOW).state).toBe('needs_you')
    }
  })

  // 0.19.4: a Store hire left half-created by a failed purchase never finishes its identity. Its
  // gate keeps retrying; the person has nothing to do, so its row stays "setting up" and the title
  // bar's indicator never lists it, however long it lasts.
  it('never asks for the person for an agent still being set up', () => {
    const hire = agent('researcher', { readiness: blocked('agent_initializing', 24 * 60 * 60_000) })

    expect(matrixAgentAttention(hire, NOW).state).toBe('not_running')
    expect(matrixAttentionItems(snapshot([agent('atum'), hire]), NOW)).toEqual([])
  })

  it('gives a failed trust step the watch’s own retries before it asks', () => {
    const early = matrixAgentAttention(agent('moon', { readiness: blocked('agent_trust_failed', 30_000) }), NOW)
    expect(early.state).toBe('not_running')
    expect(early.wakeAt).toBe(NOW - 30_000 + MATRIX_TRUST_GRACE_MS)
    expect(
      matrixAgentAttention(agent('moon', { readiness: blocked('agent_trust_failed', MATRIX_TRUST_GRACE_MS) }), NOW)
        .state
    ).toBe('needs_you')
  })

  // 2026-10-06 check: these come from the gate itself (a Hermes start that failed, a model not set
  // up, a step that threw) and the gate retries them; read as unknown, one failed start at launch
  // lit amber 4 s later, while the gate's own 5 s retry was still pending.
  it.each(['hermes_unavailable', 'setup_required', 'unexpected'])(
    'gives %s, which the gate retries by itself, its retries before it asks',
    code => {
      expect(matrixAgentAttention(agent('moon', { readiness: blocked(code, 20_000) }), NOW)).toMatchObject({
        state: 'not_running',
        wakeAt: NOW - 20_000 + MATRIX_GATE_GRACE_MS
      })
      expect(matrixAgentAttention(agent('moon', { readiness: blocked(code, MATRIX_GATE_GRACE_MS) }), NOW).state).toBe(
        'needs_you'
      )
    }
  )

  it('lets an unknown code outlast the gate’s first retry and that retry’s own run before it asks', () => {
    // The first backoff at its slowest (+20% jitter), then up to 9 s for the retry to run.
    const firstRetry = MATRIX_READINESS_TIMINGS.backoffMs[0]! * 1.2 + 9_000

    expect(matrixAgentAttention(agent('moon', { readiness: blocked('something_new', firstRetry) }), NOW).state).toBe(
      'not_running'
    )
    expect(MATRIX_UNKNOWN_GRACE_MS).toBeGreaterThan(firstRetry)
  })

  it('says nothing in a starting agent’s chat until the start is slow', () => {
    const starting = (ago: number) =>
      matrixAgentAttention(
        agent('moon', { readiness: { phase: 'starting', step: 'assistant', since: NOW - ago } }),
        NOW
      )

    expect(starting(5_000)).toMatchObject({ state: 'not_running', wakeAt: NOW - 5_000 + MATRIX_SLOW_START_MS })
    expect(starting(5_000).chatLine).toBeUndefined()
    expect(starting(MATRIX_SLOW_START_MS)).toMatchObject({ state: 'not_running', chatLine: true })
  })

  it('asks for the person over listening only for a Stop this Mac could not save', () => {
    const listening = (extra: Partial<NonNullable<MatrixAgentView['listening']>>) =>
      matrixAgentAttention(
        agent('moon', { listening: { roomId: '!r', expiresAt: NOW + 1, queued: 0, state: 'paused', ...extra } }),
        NOW
      ).state

    // What recovers by itself (0.20) never asks: pauses, an overflowing or unavailable watch, an
    // interrupted turn, an outcome nobody knows.
    for (const reason of [
      'renewing',
      'busy',
      'offline',
      'room_changed',
      'document',
      'lease_elsewhere',
      'unavailable',
      'overflow'
    ] as const) {
      expect(listening({ reason })).toBe('ready')
    }

    expect(listening({ state: 'listening', interruptedEventId: '$e' })).toBe('ready')
    expect(listening({ state: 'stopped', reason: 'unavailable', result: 'unknown' })).toBe('ready')
    expect(listening({ reason: 'storage' })).toBe('needs_you')
  })
})

describe('the indicator’s items', () => {
  it('holds nothing while every agent is starting, checking trust or ready', () => {
    const agents = Array.from({ length: 6 }, (_, at) =>
      agent(`agent${at}`, {
        readiness:
          at % 2 ? { phase: 'starting', step: 'assistant', since: NOW - 2_000 } : { phase: 'ready', since: NOW - 1_000 }
      })
    )

    expect(matrixAttentionItems(snapshot(agents), NOW)).toEqual([])
  })

  it('is one item for a cause every agent shares, never one per agent', () => {
    const agents = Array.from({ length: 6 }, (_, at) =>
      agent(`agent${at}`, { readiness: blocked('recovery_required') })
    )

    expect(matrixAttentionItems(snapshot(agents), NOW)).toEqual([{ kind: 'recovery', tone: 'warn' }])
  })

  it('names the agent that needs the person, after its grace', () => {
    const fresh = snapshot([agent('atum'), agent('moon', { readiness: blocked('something_new', 1_000) })])
    expect(matrixAttentionItems(fresh, NOW)).toEqual([])
    expect(matrixAttentionWakeAt(fresh, NOW)).toBe(NOW - 1_000 + MATRIX_UNKNOWN_GRACE_MS)
    expect(matrixAttentionItems(fresh, NOW + MATRIX_UNKNOWN_GRACE_MS)).toEqual([
      { kind: 'agent', principal: 'moon', tone: 'warn' }
    ])
  })

  it('names an agent whose ChatGPT sign-in ended as that, not as one that merely needs the person', () => {
    // Its setup failed for that reason: main reports the plan sign-in, not `setup_failed`.
    const view = snapshot([
      agent('atum', { setup: 'failed', readiness: blocked('plan_sign_in', 1_000) }),
      agent('moon', { readiness: blocked('plan_sign_in') }),
      agent('sun', { readiness: blocked('setup_failed') })
    ])

    expect(matrixAttentionItems(view, NOW)).toEqual([
      { kind: 'plan_sign_in', principal: 'atum', tone: 'warn' },
      { kind: 'plan_sign_in', principal: 'moon', tone: 'warn' },
      { kind: 'agent', principal: 'sun', tone: 'warn' }
    ])
  })

  it('lists several causes most pressing first, and lets a full-ish disk wait a day', () => {
    const view = snapshot([agent('atum'), agent('moon', { readiness: blocked('agent_reconnect_required') })], {
      disk: { state: 'low', freeGb: 8 },
      security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: NOW } }
    })

    expect(matrixAttentionItems(view, NOW).map(item => item.kind)).toEqual(['approval', 'agent', 'disk_low'])
    expect(matrixAttentionItems(view, NOW, { diskLowSnoozed: true }).map(item => item.kind)).toEqual([
      'approval',
      'agent'
    ])
    expect(matrixAttentionItems({ ...view, disk: { state: 'critical', freeGb: 1 }, deviceDamaged: true }, NOW)).toEqual(
      [
        { kind: 'approval', tone: 'warn' },
        { kind: 'device_damaged', tone: 'danger' },
        { kind: 'disk_critical', tone: 'danger' },
        { kind: 'agent', principal: 'moon', tone: 'warn' }
      ]
    )
  })

  // 2026-10-06 check: every item went whenever the connection was not `ready`, so a disk, a damaged
  // device and a live approval dropped out of the indicator and came back on every blip.
  it('keeps this Mac’s own items through a connection blip, and the agents’ for when it is back', () => {
    const view = snapshot([agent('moon', { readiness: blocked('agent_reconnect_required') })], {
      disk: { state: 'critical', freeGb: 1 },
      deviceDamaged: true,
      security: { recovery: 'idle', approval: { role: 'approve', state: 'asked', since: NOW } }
    })

    expect(matrixAttentionItems(view, NOW).map(item => item.kind)).toEqual([
      'approval',
      'device_damaged',
      'disk_critical',
      'agent'
    ])

    for (const state of ['offline', 'connecting', 'error'] as const) {
      expect(matrixAttentionItems({ ...view, state }, NOW).map(item => item.kind)).toEqual([
        'approval',
        'device_damaged',
        'disk_critical'
      ])
    }

    expect(matrixAttentionItems({ ...view, state: 'offline', disk: { state: 'low', freeGb: 8 } }, NOW).at(-1)).toEqual({
      kind: 'disk_low',
      tone: 'warn'
    })
    // Signed out: no one to ask.
    expect(matrixAttentionItems({ ...view, state: 'signed_out', identity: null }, NOW)).toEqual([])
  })

  it('drops an approval once it ends, and everything once the cause clears', () => {
    const asking = snapshot([agent('atum', { readiness: blocked('out_of_protons') })], {
      security: { recovery: 'idle', approval: { role: 'approve', state: 'compare', since: NOW } }
    })

    expect(matrixAttentionItems(asking, NOW).map(item => item.kind)).toEqual(['approval', 'protons'])

    for (const state of ['done', 'timeout', 'declined', 'mismatch', 'failed'] as const) {
      expect(
        matrixAttentionItems(
          {
            ...asking,
            agents: [agent('atum')],
            security: { recovery: 'idle', approval: { role: 'approve', state, since: NOW } }
          },
          NOW
        )
      ).toEqual([])
    }

    // This Mac asking (a new device): its own flow, not the indicator's.
    expect(
      matrixAttentionItems(
        {
          ...asking,
          agents: [agent('atum')],
          security: { recovery: 'idle', approval: { role: 'request', state: 'waiting', since: NOW } }
        },
        NOW
      )
    ).toEqual([])
  })
})

// 2026-10-06 check: the table measures every grace from `readiness.since`. The real gate starts
// again from its first step on every retry, so a block that kept failing came back with a fresh
// `since` each time (at most ~72 s apart): a trust failure never reached its 90 s and never asked,
// and an unknown code lit and cleared the indicator on every retry. These run the real monitor.
describe('an agent whose start keeps failing, through the real readiness gate', () => {
  /** The real gate (signed in, then this agent's own step failing with `code`, taking 1.5 s), read
   * by the table once a second for `seconds`, as the window reads each snapshot. */
  async function run(code: string, seconds: number) {
    vi.useFakeTimers()

    try {
      const began = Date.now()
      let readiness: MatrixReadiness | undefined
      let attempts = 0

      const monitor = new MatrixReadinessMonitor({
        gate: [
          { step: 'signed_in', check: async () => ({ ok: true }) },
          {
            step: 'assistant',
            check: async () => {
              await new Promise(resolve => setTimeout(resolve, 1_500))
              attempts += 1

              return { ok: false, code }
            }
          }
        ],
        watch: [],
        onChange: value => {
          readiness = value
        },
        // The slowest jitter: the longest a retried block lasted before it started over (72 s).
        random: () => 1
      })

      const samples: { at: number; attempts: number; state: string; items: string }[] = []
      monitor.start()

      for (let second = 1; second <= seconds; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000)
        const now = Date.now()
        const moon = agent('moon', { readiness })

        samples.push({
          at: now - began,
          attempts,
          state: matrixAgentAttention(moon, now).state,
          items: matrixAttentionItems(snapshot([agent('atum'), moon]), now)
            .map(item => `${item.kind}:${item.principal ?? ''}`)
            .join(',')
        })
      }

      monitor.stop()

      return samples
    } finally {
      vi.useRealTimers()
    }
  }

  /** How many times the indicator's items changed. */
  const changes = (samples: { items: string }[]) =>
    samples.filter((sample, at) => sample.items !== (at ? samples[at - 1]!.items : '')).length

  it('turns a trust failure amber once it outlasts its 90 s, and keeps it so', async () => {
    const samples = await run('agent_trust_failed', 400)
    const first = samples.findIndex(sample => sample.state === 'needs_you')

    expect(first).toBeGreaterThan(-1)
    // Its grace counts from the first failure (1.5 s in), never from a retry.
    expect(samples[first]!.at).toBeGreaterThanOrEqual(1_500 + MATRIX_TRUST_GRACE_MS)
    expect(samples[first]!.at).toBeLessThanOrEqual(1_500 + MATRIX_TRUST_GRACE_MS + 1_000)
    expect(samples.slice(first).every(sample => sample.state === 'needs_you')).toBe(true)
    expect(samples.slice(first).every(sample => sample.items === 'agent:moon')).toBe(true)
    // Retried the whole time, and the indicator changed once.
    expect(samples.at(-1)!.attempts).toBeGreaterThanOrEqual(6)
    expect(changes(samples)).toBe(1)
  })

  it.each(['hermes_unavailable', 'setup_required', 'unexpected', 'something_new'])(
    'surfaces %s once, never while the gate’s first retry is pending, and never flickers',
    async code => {
      const samples = await run(code, 400)
      const first = samples.findIndex(sample => sample.items !== '')

      expect(first).toBeGreaterThan(-1)
      // One failed start at launch is not enough: the gate's own retry ran and failed too.
      expect(samples[first]!.attempts).toBeGreaterThanOrEqual(2)
      expect(changes(samples)).toBe(1)
      expect(samples.slice(first).every(sample => sample.state === 'needs_you')).toBe(true)
    }
  )
})

describe('the person’s own unverified devices (0.20)', () => {
  const NOW = new Date(2026, 9, 6, 9).getTime()
  const phone = { deviceId: 'PHONE', name: 'iPhone 16 Pro', lastSeenAt: NOW - 60_000 }
  const ipad = { deviceId: 'IPAD', lastSeenAt: NOW - 3_600_000 }

  const snapshot = (extra: Partial<MatrixSnapshot> = {}): MatrixSnapshot => ({
    state: 'ready',
    identity: { userId: '@owner:test', deviceId: 'MAC' },
    rooms: [],
    roomId: null,
    messages: [],
    error: null,
    agents: [],
    security: { recovery: 'idle', unverifiedDevices: [phone, ipad] },
    ...extra
  })

  // 0.20: chats are plain, so no assistant refuses one of the person's devices; a reminder to
  // verify one would say something false. Main no longer lists them either.
  it('never raises a device to verify, even for a snapshot that lists unverified devices', () => {
    expect(matrixAttentionItems(snapshot({ disk: { state: 'low', freeGb: 8 } }), NOW)).toEqual([
      { kind: 'disk_low', tone: 'warn' }
    ])
    expect(matrixAttentionItems(snapshot(), NOW)).toEqual([])
    expect(matrixAttentionItems(snapshot({ state: 'offline' }), NOW)).toEqual([])
  })
})

// Preserve user-visible identity, state and recovery behavior across connection changes.
describe('a new sign-in on another device', () => {
  const signIn = { deviceId: 'PHONE', name: 'Atum for iPhone on Unknown device' }

  it('is one item for that device, after a damaged device and before the disk', () => {
    const view = snapshot([agent('atum')], {
      newSignIn: signIn,
      deviceDamaged: true,
      disk: { state: 'low', freeGb: 8 }
    })

    expect(matrixAttentionItems(view, NOW)).toEqual([
      { kind: 'device_damaged', tone: 'danger' },
      { kind: 'new_sign_in', newSignIn: signIn, tone: 'warn' },
      { kind: 'disk_low', tone: 'warn' }
    ])
  })

  it('stays through a connection blip and goes once main has accounted for it', () => {
    expect(matrixAttentionItems(snapshot([], { state: 'connecting', newSignIn: signIn }), NOW)).toEqual([
      { kind: 'new_sign_in', newSignIn: signIn, tone: 'warn' }
    ])
    expect(matrixAttentionItems(snapshot([]), NOW)).toEqual([])
    expect(matrixAttentionItems(snapshot([], { identity: undefined, newSignIn: signIn }), NOW)).toEqual([])
  })
})
