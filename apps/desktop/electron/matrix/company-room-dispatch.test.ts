import { describe, expect, it, vi } from 'vitest'

import type { MatrixRoom } from '../../shared/matrix'
import { MATRIX_COMPANY_CONVERSATION_TYPE } from '../../shared/matrix-company-channel-room'
import { MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE } from '../../shared/matrix-company-private-cos'

import { createPresentationDispatch, createRoomCommandGuard } from './company-room-dispatch'
import { parseMatrixCommand } from './ipc-policy'

const COMPANY = '00000000-0000-4000-8000-87c6455cae48'
const CONVERSATION = '00000000-0000-4000-8000-f6c6b8bb709f'

const claim = (id: string): MatrixRoom => ({
  id,
  name: id,
  membership: 'join',
  encrypted: false,
  roomType: MATRIX_COMPANY_CONVERSATION_TYPE,
  companyConversation: { companyId: COMPANY, conversationId: CONVERSATION }
})

const plain: MatrixRoom = { id: '!plain:test', name: 'Plain', membership: 'join', encrypted: true }

function make(rooms: MatrixRoom[], confirmed: (room: MatrixRoom) => boolean) {
  const run = vi.fn(async (_command: unknown) => null)

  const dispatch = createPresentationDispatch({
    parse: parseMatrixCommand,
    guard: createRoomCommandGuard({ rooms: () => rooms, directory: async () => ({}), confirmsConversation: confirmed }),
    run
  })

  return { dispatch, run }
}

describe('presentation commands (attend, typing) go through the same room guard', () => {
  it('keeps private Chief of Staff membership owner-managed while allowing ordinary room use', async () => {
    const room: MatrixRoom = {
      id: '!private-cos:test',
      name: 'Chief of Staff',
      membership: 'join',
      encrypted: false,
      roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
      companyPrivateCos: {
        v: 1,
        classification: 'company_private_cos',
        companyId: COMPANY,
        membershipIncarnation: '00000000-0000-4000-8000-8a4e23bab81e',
        executorId: '00000000-0000-4000-8000-f9ae298d66d3'
      }
    }
    const guard = createRoomCommandGuard({
      rooms: () => [room],
      directory: async () => ({}),
      confirmsConversation: () => false
    })

    await expect(guard('invite', room.id)).rejects.toThrow('matrix_company_private_cos_managed')
    await expect(guard('select', room.id)).resolves.toBeUndefined()
  })

  it.each([
    ['attend', { kind: 'attend', roomId: '!dm:test' }],
    ['typing', { kind: 'typing', roomId: '!dm:test', typing: true }]
  ])('%s is refused for a conversation room the platform does not list, and never reaches the SDK', async (_name, command) => {
    const { dispatch, run } = make([claim('!dm:test')], () => false)

    await expect(dispatch(command)).rejects.toThrow('matrix_company_conversation_unconfirmed')
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'attend', roomId: '!dm:test' },
    { kind: 'typing', roomId: '!dm:test', typing: false }
  ])('%j passes for a listed conversation room', async command => {
    const { dispatch, run } = make([claim('!dm:test')], () => true)

    await dispatch(command)
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ kind: command.kind, roomId: '!dm:test' }))
  })

  it('lets an ordinary room, and "no room" (attend null), through unchanged', async () => {
    const { dispatch, run } = make([plain, claim('!dm:test')], () => false)

    await dispatch({ kind: 'attend', roomId: '!plain:test' })
    await dispatch({ kind: 'typing', roomId: '!plain:test', typing: true })
    await dispatch({ kind: 'attend', roomId: null })
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('still refuses a command the parser does not accept, before anything else', async () => {
    const { dispatch, run } = make([plain], () => true)

    await expect(dispatch({ kind: 'typing', roomId: '!plain:test' })).rejects.toThrow('matrix_command_invalid')
    expect(run).not.toHaveBeenCalled()
  })
})
