import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { describe, expect, it } from 'vitest'

import type { MatrixRoom } from './matrix'
import { MATRIX_APP_GROUP_TYPE } from './matrix-app-room'
import {
  assistantOpeningBlocksRoom,
  isAgentCreatedAssistantInvitation,
  isAssistantRoom,
  MATRIX_ASSISTANT_ROOM_TYPE,
  plainAgentRoom,
  plainRoom,
  usableAgentRoom,
  withoutPersonalAgent
} from './matrix-assistant-room'

const OWNER = '@owner:test'
const AGENT = '@agent:test'

/** A real SDK room holding exactly this synced state. */
function room(options: { type?: string; encrypted?: boolean; botMarker?: boolean } = {}): Room {
  const value = new Room('!room:test', createClient({ baseUrl: 'https://matrix.test', userId: OWNER }), OWNER)

  const state = (type: string, content: Record<string, unknown>) =>
    new MatrixEvent({ type, state_key: '', sender: OWNER, room_id: value.roomId, content })

  value.currentState.setStateEvents([
    state(EventType.RoomCreate, options.type ? { type: options.type } : {}),
    ...(options.encrypted ? [state(EventType.RoomEncryption, { algorithm: 'm.megolm.v1.aes-sha2' })] : []),
    ...(options.botMarker
      ? [
          state('io.atum.app_bot.dm', {
            v: 1,
            app_id: '00000000-0000-4000-8000-e79acd97ac88',
            bot_user_id: '@app-moon:test'
          })
        ]
      : [])
  ])

  return value
}

describe('rooms without end-to-end encryption', () => {
  it('tells a room without encryption from one with it', () => {
    expect(plainRoom(room())).toBe(true)
    expect(plainRoom(room({ type: MATRIX_ASSISTANT_ROOM_TYPE }))).toBe(true)
    expect(plainRoom(room({ encrypted: true }))).toBe(false)
    expect(plainRoom(room({ type: MATRIX_ASSISTANT_ROOM_TYPE, encrypted: true }))).toBe(false)
  })

  it('is an agent or bot chat only by the existing markers, and never once encrypted', () => {
    expect(plainAgentRoom(room({ type: MATRIX_ASSISTANT_ROOM_TYPE }))).toBe(true)
    expect(plainAgentRoom(room({ botMarker: true }))).toBe(true)
    // A people chat or a group: plain, but not an agent's or a bot's.
    expect(plainAgentRoom(room())).toBe(false)
    expect(plainAgentRoom(room({ type: MATRIX_APP_GROUP_TYPE }))).toBe(false)
    // An encrypted agent or bot chat keeps the encrypted rules.
    expect(plainAgentRoom(room({ type: MATRIX_ASSISTANT_ROOM_TYPE, encrypted: true }))).toBe(false)
    expect(plainAgentRoom(room({ botMarker: true, encrypted: true }))).toBe(false)
  })
})

describe('the assistant room display hint', () => {
  const summary = (overrides: Partial<MatrixRoom>): MatrixRoom => ({
    id: '!room:test',
    name: 'Atum',
    membership: 'join',
    encrypted: false,
    roomType: MATRIX_ASSISTANT_ROOM_TYPE,
    participants: [
      { userId: OWNER, membership: 'join' },
      { userId: AGENT, membership: 'invite' }
    ],
    ...overrides
  })

  it('recognises a plain two-member assistant room as it does an encrypted one', () => {
    expect(isAssistantRoom(summary({ plainAgent: true }), OWNER, AGENT)).toBe(true)
    expect(isAssistantRoom(summary({ encrypted: true }), OWNER, AGENT)).toBe(true)
  })

  it('never takes a plain room the SDK did not project as an agent chat, or one of another type', () => {
    expect(isAssistantRoom(summary({}), OWNER, AGENT)).toBe(false)
    expect(isAssistantRoom(summary({ plainAgent: false }), OWNER, AGENT)).toBe(false)
    expect(isAssistantRoom(summary({ plainAgent: true, roomType: undefined }), OWNER, AGENT)).toBe(false)
  })

  it('never takes a company private Chief of Staff room (exact, claimed or platform-bound) for a personal one', () => {
    const marker = {
      v: 1 as const,
      classification: 'company_private_cos' as const,
      companyId: '00000000-0000-4000-8000-72805976e3a7',
      membershipIncarnation: '00000000-0000-4000-8000-4ddf7748f9cd',
      executorId: '00000000-0000-4000-8000-3570bef6c8ca'
    }

    for (const claim of [
      { companyPrivateCos: marker },
      { companyPrivateCosClaim: true as const },
      { companyPrivateCosBound: true as const }
    ]) {
      expect(isAssistantRoom(summary({ plainAgent: true, ...claim }), OWNER, AGENT)).toBe(false)
      expect(isAgentCreatedAssistantInvitation(summary({
        plainAgent: true,
        membership: 'invite',
        participants: [{ userId: OWNER, membership: 'invite' }, { userId: AGENT, membership: 'join' }],
        ...claim
      }), OWNER, AGENT)).toBe(false)
    }
  })

  it('drops a personal assistant label from a company private Chief of Staff room, and leaves other rooms as they are', () => {
    const labelled = summary({ plainAgent: true, assistant: true, agentPrincipal: 'raymond', companyPrivateCosBound: true })
    const company = withoutPersonalAgent(labelled)

    expect(company.assistant).toBe(false)
    expect('agentPrincipal' in company).toBe(false)
    expect(company.companyPrivateCosBound).toBe(true)

    const personal = summary({ plainAgent: true, assistant: true, agentPrincipal: 'raymond' })
    expect(withoutPersonalAgent(personal)).toBe(personal)
    const clean = summary({ plainAgent: true, companyPrivateCosClaim: true })
    expect(withoutPersonalAgent(clean)).toBe(clean)
  })

  it('blocks only the assistant conversation currently being opened', () => {
    const assistantRoom = summary({ plainAgent: true })

    expect(assistantOpeningBlocksRoom(AGENT, assistantRoom, OWNER)).toBe(true)
    expect(assistantOpeningBlocksRoom('@other-agent:test', assistantRoom, OWNER)).toBe(false)
    expect(assistantOpeningBlocksRoom(AGENT, summary({ plainAgent: true, roomType: undefined }), OWNER)).toBe(false)
    expect(assistantOpeningBlocksRoom(null, assistantRoom, OWNER)).toBe(false)
  })
})

describe('usableAgentRoom', () => {
  it('accepts a joined encrypted chat or a joined plain agent chat, nothing else', () => {
    expect(usableAgentRoom({ membership: 'join', encrypted: true })).toBe(true)
    expect(usableAgentRoom({ membership: 'join', encrypted: false, plainAgent: true })).toBe(true)
    // A plain room without the agent or bot markers (a people chat or a group) is not an agent chat.
    expect(usableAgentRoom({ membership: 'join', encrypted: false })).toBe(false)
    expect(usableAgentRoom({ membership: 'invite', encrypted: false, plainAgent: true })).toBe(false)
    expect(usableAgentRoom({ membership: 'leave', encrypted: true })).toBe(false)
    expect(usableAgentRoom(undefined)).toBe(false)
  })
})
