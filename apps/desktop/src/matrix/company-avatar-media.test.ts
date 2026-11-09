import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import {
  MATRIX_COMPANY_CHANNEL_BINDING,
  MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
  MATRIX_COMPANY_CHANNEL_TYPE
} from '../../shared/matrix-company-channel-room'

import { matrixMemberAvatars } from './member-avatar-media'

const OWNER = '@owner:matrix.test'
const ROOM_ID = '!company:matrix.test'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

afterEach(() => vi.restoreAllMocks())

it('uploads prepared company-logo bytes without a filename and validates the returned MXC URI', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
  const media = matrixMemberAvatars(client, () => true)
  const upload = vi.spyOn(client, 'uploadContent').mockResolvedValue({
    content_uri: 'mxc://matrix.test/company-logo'
  })

  await expect(media.uploadCompany({ type: 'image/png', bytes: PNG })).resolves.toBe('mxc://matrix.test/company-logo')
  expect(upload).toHaveBeenCalledTimes(1)
  const [blob, options] = upload.mock.calls[0]!
  expect(blob).toBeInstanceOf(Blob)
  expect((blob as Blob).type).toBe('image/png')
  expect(options).toEqual({ type: 'image/png', includeFilename: false })

  upload.mockResolvedValueOnce({ content_uri: 'https://cdn.test/company-logo.png' } as never)
  await expect(media.uploadCompany({ type: 'image/png', bytes: PNG }))
    .rejects.toThrow('matrix_company_avatar_unavailable')
  expect(vi.spyOn(client, 'setAvatarUrl')).not.toHaveBeenCalled()
})

it('downloads only the manager-written avatar of a joined company channel through authenticated media', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: OWNER })
  const room = new Room(ROOM_ID, client, OWNER)
  const event = (type: string, content: Record<string, unknown>, stateKey = '') => new MatrixEvent({
    type, state_key: stateKey, sender: OWNER, room_id: ROOM_ID, content
  })

  room.currentState.setStateEvents([
    event(EventType.RoomCreate, {
      type: MATRIX_COMPANY_CHANNEL_TYPE,
      room_version: MATRIX_COMPANY_CHANNEL_ROOM_VERSION,
      [MATRIX_COMPANY_CHANNEL_BINDING]: {
        companyId: '00000000-0000-4000-8000-bd7662a5eeb4',
        channelId: '00000000-0000-4000-8000-b454f82c5857'
      }
    }),
    event(EventType.RoomMember, { membership: 'join' }, OWNER),
    event(EventType.RoomAvatar, { url: 'mxc://matrix.test/company-logo' })
  ])
  room.updateMyMembership('join')
  client.store.storeRoom(room)
  const authed = vi.spyOn(client.http, 'authedRequest').mockResolvedValue(new Blob([PNG]))

  await expect(matrixMemberAvatars(client, () => true).readCompanyRoom(ROOM_ID)).resolves.toEqual({
    roomId: ROOM_ID,
    avatarMxc: 'mxc://matrix.test/company-logo',
    avatarUrl: 'data:image/png;base64,iVBORw0KGgo='
  })
  expect(authed).toHaveBeenCalledWith(
    'GET',
    '/media/download/matrix.test/company-logo',
    undefined,
    undefined,
    expect.objectContaining({ prefix: '/_matrix/client/v1', rawResponseBody: true })
  )
})
