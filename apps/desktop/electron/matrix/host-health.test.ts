import { describe, expect, it } from 'vitest'

import type { MatrixSnapshot } from '../../shared/matrix'

import { matrixTurnsNeedingHost } from './agent-routing'
import {
  matrixHostEndsTurns,
  matrixHostLiveness,
  matrixHostsTakeNewClaims,
  type MatrixHostState,
  matrixLeaseHostAction
} from './host-health'

type Shape = Pick<MatrixSnapshot, 'state' | 'degraded'>

describe('what a host snapshot says about carrying work', () => {
  const table: Array<[Shape, ReturnType<typeof matrixHostLiveness>]> = [
    [{ state: 'ready' }, 'live'],
    [{ state: 'ready', degraded: true }, 'degraded'],
    [{ state: 'connecting' }, 'down'],
    [{ state: 'signing_in' }, 'down'],
    [{ state: 'signed_out' }, 'down'],
    [{ state: 'offline' }, 'down'],
    [{ state: 'error' }, 'down'],
    // The flag means nothing without a ready engine.
    [{ state: 'offline', degraded: true }, 'down'],
    [{ state: 'error', degraded: true }, 'down']
  ]

  it.each(table)('reads %j as %s', (snapshot, liveness) => {
    expect(matrixHostLiveness(snapshot)).toBe(liveness)
  })

  it('ends turns only for a host that is down, never for one that is merely reconnecting', () => {
    expect(['live', 'degraded', 'down'].map(value => matrixHostEndsTurns(value as never))).toEqual([false, false, true])
  })

  it('takes a new claim only when every host is ready and none is degraded', () => {
    const live: MatrixHostState = { ready: true }
    const degraded: MatrixHostState = { ready: true, degraded: true }

    expect(matrixHostsTakeNewClaims([live, live])).toBe(true)
    expect(matrixHostsTakeNewClaims([live, degraded])).toBe(false)
    expect(matrixHostsTakeNewClaims([degraded, live])).toBe(false)
    expect(matrixHostsTakeNewClaims([live, { ready: false }])).toBe(false)
    expect(matrixHostsTakeNewClaims([live, undefined])).toBe(false)
  })
})

describe('what the lease does about its hosts', () => {
  const live = { ready: true }
  const degraded = { ready: true, degraded: true }
  const down = { ready: false }

  const table: Array<[string, Parameters<typeof matrixLeaseHostAction>[0], ReturnType<typeof matrixLeaseHostAction>]> =
    [
      ['live hosts leave it to demand', { enrolled: true, agent: live, human: live }, 'proceed'],
      ['a degraded agent host holds it', { enrolled: true, agent: degraded, human: live }, 'hold'],
      ['a degraded person host holds it', { enrolled: true, agent: live, human: degraded }, 'hold'],
      ['both degraded hold it', { enrolled: true, agent: degraded, human: degraded }, 'hold'],
      [
        'an admitted room turn holds through both missing renderers',
        { enrolled: true, admitted: true, agent: undefined, human: undefined },
        'hold'
      ],
      [
        'an admitted room turn holds through degraded renderers',
        { enrolled: true, admitted: true, agent: degraded, human: degraded },
        'hold'
      ],
      [
        'an explicitly down agent host releases an admitted turn',
        { enrolled: true, admitted: true, agent: down, human: live },
        'release'
      ],
      [
        'an explicitly down person host releases an admitted turn',
        { enrolled: true, admitted: true, agent: live, human: down },
        'release'
      ],
      ['a down agent host releases it', { enrolled: true, agent: down, human: live }, 'release'],
      ['a down person host releases it', { enrolled: true, agent: live, human: down }, 'release'],
      ['a missing agent host releases it', { enrolled: true, agent: undefined, human: live }, 'release'],
      ['a missing person host releases it', { enrolled: true, agent: live, human: undefined }, 'release'],
      ['down wins over degraded', { enrolled: true, agent: degraded, human: down }, 'release'],
      ['no enrollment releases it', { enrolled: false, agent: live, human: live }, 'release'],
      ['no enrollment releases it even when degraded', { enrolled: false, agent: degraded, human: live }, 'release'],
      [
        'no enrollment releases it even when admitted',
        { enrolled: false, admitted: true, agent: degraded, human: live },
        'release'
      ]
    ]

  it.each(table)('%s', (_name, input, action) => {
    expect(matrixLeaseHostAction(input)).toBe(action)
  })
})

describe('a turn in flight', () => {
  interface Turn {
    abort: AbortController
    setup?: true
  }

  const turn = (): Turn => ({ abort: new AbortController() })

  /** What main's snapshot handler does with one host's snapshot (electron/matrix/main.ts). */
  function applySnapshot(snapshot: Shape, agents: Array<{ role: 'agent'; invocation?: Turn }>) {
    if (matrixHostEndsTurns(matrixHostLiveness(snapshot))) {
      for (const each of matrixTurnsNeedingHost<Turn>('agent', agents)) {
        each.abort.abort()
      }
    }
  }

  it('is not aborted by a degraded host, and is by a down one', () => {
    const running = turn()
    const agents = [{ role: 'agent' as const, invocation: running }]

    applySnapshot({ state: 'ready', degraded: true }, agents)
    applySnapshot({ state: 'ready' }, agents)
    applySnapshot({ state: 'ready', degraded: true }, agents)
    expect(running.abort.signal.aborted).toBe(false)

    // Down for good (a stopped client, or a blip that outlasted its grace): as before.
    applySnapshot({ state: 'offline' }, agents)
    expect(running.abort.signal.aborted).toBe(true)
  })

  it('is aborted when the engine errors, is signed out, or is still connecting', () => {
    for (const state of ['error', 'signed_out', 'connecting'] as const) {
      const running = turn()
      applySnapshot({ state }, [{ role: 'agent' as const, invocation: running }])
      expect(running.abort.signal.aborted).toBe(true)
    }
  })

  it('keeps a model check running through anything, since it uses no host', () => {
    const check: Turn = { ...turn(), setup: true }
    applySnapshot({ state: 'offline' }, [{ role: 'agent' as const, invocation: check }])
    expect(check.abort.signal.aborted).toBe(false)
  })
})
