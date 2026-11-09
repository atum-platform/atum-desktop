import { describe, expect, it } from 'vitest'

import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../shared/matrix-assistant-room'

import type { MatrixAgentDefinitionRecord } from './agent-definition'
import {
  matrixAgentHomeRoom,
  matrixDefaultAgent,
  matrixDefaultRuntime,
  matrixRetiredRootCustody,
  matrixRetirementTarget,
  matrixRoomAgent,
  matrixRosterChanges,
  matrixTurnAgent,
  matrixTurnsNeedingHost,
  matrixTurnsUsing
} from './agent-routing'
import type { MatrixHostRole } from './sdk-host'

const OWNER = '@owner:test'

const privateRoom = (id: string, agent: string, membership = 'join') => ({
  id,
  name: id,
  membership: 'join',
  encrypted: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  participants: [
    { userId: OWNER, membership: 'join' },
    { userId: agent, membership }
  ]
})

describe('which agent a room belongs to', () => {
  const agents = [
    { name: 'default', userId: '@atum:test' },
    { name: 'alfred', userId: '@alfred:test' },
    { name: 'roster-only', userId: '@bea:test' }
  ]

  it("finds the other member of the owner's private room, invited or joined", () => {
    const rooms = [
      privateRoom('!a', '@atum:test'),
      privateRoom('!b', '@alfred:test'),
      privateRoom('!c', '@bea:test', 'invite')
    ]

    expect(matrixRoomAgent(rooms, '!a', OWNER, agents)?.name).toBe('default')
    expect(matrixRoomAgent(rooms, '!b', OWNER, agents)?.name).toBe('alfred')
    expect(matrixRoomAgent(rooms, '!c', OWNER, agents)?.name).toBe('roster-only')
  })

  it('names no agent for a group, another owner, an unknown room or an unknown agent', () => {
    const group = {
      ...privateRoom('!g', '@alfred:test'),
      participants: [...privateRoom('!g', '@alfred:test').participants, { userId: '@x:test', membership: 'join' }]
    }

    expect(matrixRoomAgent([group], '!g', OWNER, agents)).toBeUndefined()
    expect(matrixRoomAgent([privateRoom('!b', '@alfred:test')], '!b', '@someone:test', agents)).toBeUndefined()
    expect(matrixRoomAgent([], '!b', OWNER, agents)).toBeUndefined()
    expect(matrixRoomAgent([privateRoom('!z', '@zed:test')], '!z', OWNER, agents)).toBeUndefined()
  })
})

describe("which turns a host's end stops", () => {
  const turn = (name: string, app?: string) => ({ name, ...(app ? { app: { slug: app } } : {}) })

  const agents = (defaultTurn?: ReturnType<typeof turn>) => [
    { role: 'agent' as MatrixHostRole, invocation: defaultTurn },
    { role: 'agent:alfred' as MatrixHostRole, invocation: turn('alfred') },
    { role: 'agent:bea' as MatrixHostRole, invocation: undefined }
  ]

  it("ends every agent's turn with the human host, and only an agent's own with its host", () => {
    expect(matrixTurnsUsing('human', agents(turn('default'))).map(each => each.name)).toEqual(['default', 'alfred'])
    expect(matrixTurnsUsing('agent', agents(turn('default'))).map(each => each.name)).toEqual(['default'])
    expect(matrixTurnsUsing('agent:alfred', agents(turn('default'))).map(each => each.name)).toEqual(['alfred'])
    expect(matrixTurnsUsing('agent:bea', agents(turn('default')))).toEqual([])
  })

  it("keeps an app's turn in the default agent's slot tied to the app's host, not the agent's", () => {
    expect(matrixTurnsUsing('app:notes', agents(turn('notes turn', 'notes'))).map(each => each.name)).toEqual([
      'notes turn'
    ])
    expect(matrixTurnsUsing('agent', agents(turn('notes turn', 'notes')))).toEqual([])
    expect(matrixTurnsUsing('app:other', agents(turn('notes turn', 'notes')))).toEqual([])
  })

  it('keeps an app turn booked against promoted Main tied only to its human and app hosts', () => {
    const promotedMain = [
      { role: 'agent' as MatrixHostRole, invocation: turn('old root') },
      { role: 'agent:main' as MatrixHostRole, invocation: turn('notes turn', 'notes') }
    ]

    expect(matrixTurnsUsing('human', promotedMain).map(each => each.name)).toEqual(['old root', 'notes turn'])
    expect(matrixTurnsUsing('app:notes', promotedMain).map(each => each.name)).toEqual(['notes turn'])
    expect(matrixTurnsUsing('agent:main', promotedMain).map(each => each.name)).toEqual([])
  })
})

describe("which turns a host's outage ends (G1-13)", () => {
  interface Slot {
    name: string
    app?: { slug: string }
    setup?: true
  }

  const check = (name: string): Slot => ({ name, setup: true })
  const turn = (name: string, app?: string): Slot => ({ name, ...(app ? { app: { slug: app } } : {}) })

  it("keeps a model check running while the agent's own host is still connecting", () => {
    // The model check starts once the agent's host has loaded; the host then reports
    // "connecting" before its first sync. That snapshot used to end the check.
    const agents: Array<{ role: MatrixHostRole; invocation?: Slot }> = [
      { role: 'agent', invocation: check('model check') }
    ]

    expect(matrixTurnsNeedingHost('agent', agents)).toEqual([])
    // The host's stop, crash or expiry still ends it.
    expect(matrixTurnsUsing('agent', agents).map(each => each.name)).toEqual(['model check'])
  })

  it("keeps every agent's model check running through the human host's outage, and ends their turns", () => {
    const agents: Array<{ role: MatrixHostRole; invocation?: Slot }> = [
      { role: 'agent', invocation: check('default check') },
      { role: 'agent:alfred', invocation: turn('alfred turn') },
      { role: 'agent:bea', invocation: check('bea check') }
    ]

    expect(matrixTurnsNeedingHost('human', agents).map(each => each.name)).toEqual(['alfred turn'])
    expect(matrixTurnsNeedingHost('agent:bea', agents)).toEqual([])
    expect(matrixTurnsNeedingHost('agent:alfred', agents).map(each => each.name)).toEqual(['alfred turn'])
  })

  it('ends turns and app turns exactly as a stop would', () => {
    const cases: Array<Array<{ role: MatrixHostRole; invocation?: Slot }>> = [
      [{ role: 'agent', invocation: turn('default turn') }],
      [{ role: 'agent', invocation: turn('notes turn', 'notes') }]
    ]

    for (const agents of cases) {
      for (const role of ['human', 'agent', 'app:notes', 'agent:alfred'] as MatrixHostRole[]) {
        expect(matrixTurnsNeedingHost(role, agents)).toEqual(matrixTurnsUsing(role, agents))
      }
    }
  })
})

describe('what a roster means for this Mac', () => {
  const record = (principal: string, extra: Partial<MatrixAgentDefinitionRecord> = {}): MatrixAgentDefinitionRecord =>
    ({
      id: `${principal}-id`,
      principal,
      displayName: principal,
      isDefault: false,
      status: 'active',
      matrixUser: `@${principal}:test`,
      ...extra
    }) as MatrixAgentDefinitionRecord

  const roster = [
    record('default', { isDefault: true }),
    record('alfred'),
    record('pre-matrix', { matrixUser: undefined })
  ]

  it('runs the active agents that answer in Matrix, and never the default agent twice', () => {
    const { active } = matrixRosterChanges({ roster, defaultPrincipal: 'default', known: [], keep: new Set() })
    expect(active.map(each => each.principal)).toEqual(['alfred'])
  })

  it('reserves the product default for empty root bootstrap before creating named runtimes', () => {
    const result = matrixRosterChanges({ roster, known: [], keep: new Set() })

    expect(result.active.map(each => each.principal)).toEqual(['alfred'])
    expect(result.retired).toEqual([])
  })

  it('keeps a product default with existing named custody in that named slot', () => {
    const result = matrixRosterChanges({ roster, known: ['default'], keep: new Set() })

    expect(result.active.map(each => each.principal)).toEqual(['default', 'alfred'])
    expect(result.retired).toEqual([])
  })

  it('retires what this Mac knows that the roster no longer lists', () => {
    const { retired } = matrixRosterChanges({
      roster,
      defaultPrincipal: 'default',
      known: ['alfred', 'gone', 'gone', 'pre-matrix'],
      keep: new Set()
    })

    // Listed but not answering in Matrix is not retired.
    expect(retired).toEqual(['gone'])
  })

  it('retires nothing from a roster without the default agent, or before it is set up', () => {
    const partial = [record('alfred')]
    expect(
      matrixRosterChanges({ roster: partial, defaultPrincipal: 'default', known: ['gone'], keep: new Set() }).retired
    ).toEqual([])
    expect(matrixRosterChanges({ roster, known: ['gone'], keep: new Set() }).retired).toEqual([])
    expect(
      matrixRosterChanges({
        roster: [record('other-default', { isDefault: true })],
        defaultPrincipal: 'default',
        known: ['gone'],
        keep: new Set()
      }).retired
    ).toEqual([])
  })

  it('leaves alone what is being created or retired here', () => {
    expect(
      matrixRosterChanges({
        roster,
        defaultPrincipal: 'default',
        known: ['new', 'leaving'],
        keep: new Set(['new', 'leaving'])
      }).retired
    ).toEqual([])
  })

  it('keeps a promoted named agent active without relabeling or retiring root custody', () => {
    const promoted = [record('default'), record('alfred', { isDefault: true })]

    const result = matrixRosterChanges({
      roster: promoted,
      defaultPrincipal: 'default',
      known: ['alfred'],
      keep: new Set()
    })

    expect(result.active.map(each => each.principal)).toEqual(['alfred'])
    expect(result.retired).toEqual([])
    expect(matrixDefaultAgent(promoted).principal).toBe('alfred')
  })

  it('still reconciles named retirements after the original root has retired', () => {
    const result = matrixRosterChanges({
      roster: [record('default', { status: 'retired' }), record('alfred', { isDefault: true })],
      defaultPrincipal: 'default',
      known: ['alfred', 'gone'],
      keep: new Set()
    })
    expect(result.active.map(each => each.principal)).toEqual(['alfred'])
    expect(result.retired).toEqual(['gone'])
  })

  it('supports a new device whose root slot is the promoted principal', () => {
    const promoted = [record('default'), record('alfred', { isDefault: true })]
    const result = matrixRosterChanges({ roster: promoted, defaultPrincipal: 'alfred', known: [], keep: new Set() })
    expect(result.active.map(each => each.principal)).toEqual(['default'])
    expect(result.retired).toEqual([])
  })

  it('rejects ambiguous, missing, non-Matrix or duplicate-principal role projections', () => {
    for (const invalid of [
      [],
      [record('one')],
      [record('one', { isDefault: true, matrixUser: undefined })],
      [record('one', { isDefault: true }), record('two', { isDefault: true })],
      [record('one', { isDefault: true }), record('one')]
    ]) {
      expect(() => matrixDefaultAgent(invalid)).toThrow('matrix_agent_roster_invalid')
    }
  })
})

describe('product default is a role, not custody', () => {
  it('finds retained turn custody after promotion and refuses unknown turns', () => {
    const root = { localTurns: { get: (id: string) => (id === 'old-turn' ? { id } : undefined) } }
    const main = { localTurns: { get: (id: string) => (id === 'main-turn' ? { id } : undefined) } }
    expect(matrixTurnAgent('main-turn', [root, main])).toBe(main)
    expect(matrixTurnAgent('old-turn', [root, main])).toBe(root)
    expect(matrixTurnAgent('unknown-turn', [root, main])).toBeUndefined()
  })

  it('selects Main without replacing the root runtime or its stored state', () => {
    const root = { agentPrincipal: 'old', home: 'root-home', key: 'root-key' }
    const main = { agentPrincipal: 'main', home: 'main-home', key: 'main-key' }
    expect(matrixDefaultRuntime('main', root, [root, main])).toBe(main)
    expect(matrixDefaultRuntime(undefined, root, [root, main])).toBe(root)
    expect(root).toEqual({ agentPrincipal: 'old', home: 'root-home', key: 'root-key' })
    expect(matrixDefaultRuntime('missing', root, [root, main])).toBeUndefined()
  })

  it('resolves the same principal on a fresh device with a different physical slot', () => {
    const root = { agentPrincipal: 'main' }
    expect(matrixDefaultRuntime('main', root, [root])).toBe(root)
  })

  it('protects Main regardless of whether it is named or occupies the new device root slot', () => {
    // The root's runtime label can be absent after a local withdrawal; its durable
    // enrollment principal remains the authority for selecting the physical slot.
    const oldRoot = {}
    const namedMain = { agentPrincipal: 'main' }
    expect(matrixRetirementTarget('old', 'old', oldRoot, [oldRoot, namedMain], namedMain)).toBe(oldRoot)
    expect(matrixRetirementTarget('main', 'old', oldRoot, [oldRoot, namedMain], namedMain)).toBeUndefined()

    const freshRootMain = { agentPrincipal: 'main' }
    expect(matrixRetirementTarget('main', 'main', freshRootMain, [freshRootMain], freshRootMain)).toBeUndefined()
  })

  it('accepts only an explicit retired root tombstone for cross-Mac root cleanup', () => {
    const old = {
      id: 'old-id',
      principal: 'old',
      displayName: 'Trợ lý',
      isDefault: false,
      status: 'retired' as const
    } as MatrixAgentDefinitionRecord
    const main = {
      id: 'main-id',
      principal: 'main',
      displayName: 'Main',
      isDefault: true,
      status: 'active' as const,
      matrixUser: '@main:test'
    } as MatrixAgentDefinitionRecord

    expect(
      matrixRetiredRootCustody({ roster: [old, main], rootPrincipal: 'old', productDefaultPrincipal: 'main' })
    ).toBe(old)
    expect(
      matrixRetiredRootCustody({ roster: [main], rootPrincipal: 'old', productDefaultPrincipal: 'main' })
    ).toBeUndefined()
    expect(
      matrixRetiredRootCustody({
        roster: [{ ...old, status: 'active' }, main],
        rootPrincipal: 'old',
        productDefaultPrincipal: 'main'
      })
    ).toBeUndefined()
    expect(
      matrixRetiredRootCustody({ roster: [main], rootPrincipal: 'main', productDefaultPrincipal: 'main' })
    ).toBeUndefined()
    expect(
      matrixRetiredRootCustody({ roster: [old, main], rootPrincipal: undefined, productDefaultPrincipal: 'main' })
    ).toBeUndefined()
  })
})


it('chooses the marked home before legacy lowest-ID rooms, preserving the unmarked ordering', () => {
  const legacy = privateRoom('!a:test', '@alfred:test')
  const main = { ...privateRoom('!z:test', '@alfred:test'), conversation: { role: 'main' as const, main: '!z:test', at: 1 }, conversationOwnerId: OWNER }
  expect(matrixAgentHomeRoom([legacy, main], OWNER, '@alfred:test')).toBe(main.id)
  expect(matrixAgentHomeRoom([{ ...main, conversation: null }, legacy], OWNER, '@alfred:test')).toBe(legacy.id)
})

it('never makes a room marked Earlier the home, even when no room is marked main (0.20.1)', () => {
  const marked = (id: string, role: 'main' | 'earlier', main: string) => ({
    ...privateRoom(id, '@alfred:test'),
    conversation: { role, main, at: 1 },
    conversationOwnerId: OWNER
  })

  // The crossed move: every room Earlier, none main. The lowest ID used to be the home.
  const crossed = [marked('!a:test', 'earlier', '!c:test'), marked('!b:test', 'earlier', '!c:test'), marked('!c:test', 'earlier', '!a:test')]
  expect(matrixAgentHomeRoom(crossed, OWNER, '@alfred:test')).toBeUndefined()

  // A main restored: it is the home, whatever the IDs.
  const restored = [marked('!a:test', 'earlier', '!c:test'), marked('!b:test', 'earlier', '!c:test'), marked('!c:test', 'main', '!c:test')]
  expect(matrixAgentHomeRoom(restored, OWNER, '@alfred:test')).toBe('!c:test')

  // An unmarked room beside Earlier ones (no main yet) is still a home; the Earlier ones never are.
  expect(matrixAgentHomeRoom([...crossed.slice(1), privateRoom('!z:test', '@alfred:test')], OWNER, '@alfred:test')).toBe('!z:test')
})
