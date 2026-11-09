import { describe, expect, it } from 'vitest'

import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'

import { agentStatus } from './agent-roster'
import { agentRoomId, anyAgentPrompts, otherAgents, primaryAgent, snapshotForRoom } from './room-agent'

const readiness = { phase: 'ready' as const, since: 1 }

const agent = (principal: string, extra: Partial<MatrixAgentView> = {}): MatrixAgentView => ({
  principal,
  userId: `@${principal}:test`,
  isDefault: principal === 'default',
  ready: true,
  hermes: 'ready',
  readiness,
  atumModel: true,
  ...extra
})

const room = (id: string, agentPrincipal?: string) => ({
  id,
  name: id,
  membership: 'join',
  encrypted: true,
  ...(agentPrincipal ? { agentPrincipal } : {})
})

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'D' },
  assistant: { userId: '@default:test', deviceId: 'A' },
  hermes: 'running',
  readiness: { phase: 'degraded', since: 2 },
  atumModel: false,
  hermesActivity: { invocationId: 'i', state: 'running', text: 'default at work', tools: [], roomId: '!default' },
  roomId: '!default',
  rooms: [room('!default', 'default'), room('!alfred', 'alfred'), room('!group')],
  messages: [],
  error: null,
  agents: [agent('default'), agent('alfred', { name: 'Alfred', deviceId: 'AL', atumModel: true })],
  agentTurns: [{ roomId: '!alfred', prompts: [{ id: 'p', kind: 'sudo', deadlineAt: 9 }] }]
}

describe("the selected room's agent", () => {
  it("leaves the default agent's room and any other room exactly as they are", () => {
    const group = { ...snapshot, roomId: '!group' }
    const none = { ...snapshot, roomId: null }
    expect(snapshotForRoom(snapshot)).toBe(snapshot)
    expect(snapshotForRoom(group)).toBe(group)
    expect(snapshotForRoom(none)).toBe(none)
  })

  it("puts another agent's own state in the default agent's place in its room", () => {
    const view = snapshotForRoom({ ...snapshot, roomId: '!alfred' })
    expect(view.assistant).toEqual({ userId: '@alfred:test', deviceId: 'AL' })
    expect(view.readiness).toEqual(readiness)
    expect(view.hermes).toBe('ready')
    expect(view.atumModel).toBe(true)
    // The default agent's work in progress is not Alfred's.
    expect(view.hermesActivity).toBeUndefined()
    expect(view.hermesPrompts).toEqual({ roomId: '!alfred', prompts: [{ id: 'p', kind: 'sudo', deadlineAt: 9 }] })
    // An app's turn elsewhere does not pause Alfred.
    expect(
      snapshotForRoom({ ...snapshot, roomId: '!alfred', appTurn: { appId: 'app', roomId: '!group' } }).appTurn
    ).toBeUndefined()
  })

  it("puts another agent's continuous-listening state in its own room only", () => {
    const listening = {
      roomId: '!alfred',
      expiresAt: 9,
      queued: 0,
      mode: 'continuous' as const,
      state: 'paused' as const,
      reason: 'lease_elsewhere' as const
    }

    const withListening = {
      ...snapshot,
      hermesListening: { roomId: '!default', expiresAt: 4, queued: 0, state: 'listening' as const },
      agents: [agent('default'), agent('alfred', { name: 'Alfred', deviceId: 'AL', listening })]
    }

    expect(snapshotForRoom({ ...withListening, roomId: '!alfred' }).hermesListening).toEqual(listening)
    expect(snapshotForRoom({ ...withListening, roomId: '!default' }).hermesListening).toEqual(
      withListening.hermesListening
    )
  })

  it('keeps promoted Main as the primary while the former root projects only its own runtime and turn', () => {
    const oldListening = { roomId: '!default', expiresAt: 9, queued: 0, state: 'paused' as const }
    const mainListening = { roomId: '!main', expiresAt: 10, queued: 1, state: 'listening' as const }

    const former = agent('default', {
      isDefault: false,
      deviceId: 'OLD',
      hermes: 'unavailable',
      readiness: { phase: 'degraded', since: 3 },
      setup: 'failed',
      atumModel: false,
      listening: oldListening
    })

    const main = agent('main', { isDefault: true, name: 'Atum Main', deviceId: 'MAIN', listening: mainListening })

    const promoted: MatrixSnapshot = {
      ...snapshot,
      assistant: { userId: main.userId, deviceId: 'MAIN' },
      agents: [former, main],
      rooms: [room('!default', 'default'), room('!main', 'main')],
      roomId: '!main',
      hermes: 'ready',
      readiness,
      assistantSetup: undefined,
      atumModel: true,
      hermesListening: mainListening,
      hermesActivity: { invocationId: 'main-i', state: 'running', text: 'Main work', tools: [], roomId: '!main' },
      hermesPrompts: { roomId: '!main', prompts: [{ id: 'main-p', kind: 'sudo', deadlineAt: 10 }] },
      agentTurns: [{ roomId: '!default', prompts: [{ id: 'old-p', kind: 'sudo', deadlineAt: 9 }] }]
    }

    expect(primaryAgent(promoted)).toBe(main)
    expect(otherAgents(promoted)).toEqual([former])
    expect(snapshotForRoom(promoted)).toBe(promoted)
    const oldView = snapshotForRoom({ ...promoted, roomId: '!default' })
    expect(oldView).toMatchObject({
      assistant: { userId: former.userId, deviceId: 'OLD' },
      readiness: former.readiness,
      hermes: 'unavailable',
      assistantSetup: 'failed',
      atumModel: false,
      hermesListening: oldListening,
      hermesPrompts: { roomId: '!default', prompts: [{ id: 'old-p', kind: 'sudo', deadlineAt: 9 }] }
    })
    expect(oldView.hermesActivity).toBeUndefined()
    expect(promoted.assistant).toEqual({ userId: main.userId, deviceId: 'MAIN' })
  })

  it("finds each agent's room and knows when any agent waits for input", () => {
    expect(otherAgents(snapshot).map(each => each.principal)).toEqual(['alfred'])
    expect(agentRoomId(snapshot, 'alfred')).toBe('!alfred')
    expect(agentRoomId(snapshot, 'bea')).toBeUndefined()
    expect(anyAgentPrompts(snapshot)).toBe(true)
    expect(anyAgentPrompts({ ...snapshot, agentTurns: [] })).toBe(false)
  })

  it('says only what is wrong with an agent, on its own row', () => {
    expect(agentStatus(agent('alfred'))).toBeUndefined()
    expect(agentStatus(agent('alfred', { setup: 'working' }))).toBe('agentSettingUp')
    expect(agentStatus(agent('alfred', { readiness: { phase: 'starting', since: 1 } }))).toBe('agentSettingUp')
    expect(agentStatus(agent('alfred', { setup: 'failed' }))).toBe('agentUnavailable')
    expect(agentStatus(agent('alfred', { readiness: { phase: 'blocked', since: 1, code: 'offline' } }))).toBe(
      'agentUnavailable'
    )
    // A cloud-only assistant never ran local setup: a stale local failure is not its state.
    expect(
      agentStatus(
        agent('alfred', {
          answering: 'cloud',
          ready: false,
          setup: 'failed',
          readiness: { phase: 'blocked', since: 1, code: 'setup_failed' }
        })
      )
    ).toBeUndefined()
  })
})
