import { createClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { expect, it } from 'vitest'

import { matrixOpenLink, parseMatrixCommand } from '../../electron/matrix/ipc-policy'
import { matrixGeoPoint } from '../../shared/matrix-rich-content'

import { matrixMessage } from './message'

const user = '@reader:test'
const roomId = '!test:test'

function project(type: string, content: object) {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: user })
  const room = new Room(roomId, client, user)
  const event = new MatrixEvent({ type, room_id: roomId, sender: '@sender:test', content, event_id: '$rich' })

  return matrixMessage(event, user, new Set(), room, false, true)
}

it('keeps sticker alt text and uses authenticated attachment rendering', () => {
  const sticker = project('m.sticker', {
    body: 'A waving hand', url: 'mxc://test/image', info: { mimetype: 'image/webp' }
  })

  expect(sticker).toMatchObject({
    attachment: true, body: 'A waving hand', rich: { kind: 'sticker', mimeType: 'image/webp' }
  })
})

it('reads legacy and extensible locations and rejects coordinates with URL syntax', () => {
  expect(project('m.room.message', {
    msgtype: 'm.location', geo_uri: 'geo:10.5,106.7', body: 'Meet here'
  })).toMatchObject({ body: 'Meet here', rich: { kind: 'location', geoUri: 'geo:10.5,106.7' } })
  expect(project('m.room.message', {
    msgtype: 'm.location', 'org.matrix.msc3488.location': { uri: 'geo:10.5,106.7;u=10' }, body: 'Meet here'
  })?.rich).toEqual({ kind: 'location', geoUri: 'geo:10.5,106.7' })
  expect(matrixGeoPoint('geo:91,180')).toBeUndefined()
  expect(() => matrixOpenLink('geo:10.5,106.7&url=script')).toThrow('matrix_link_invalid')
  expect(matrixOpenLink('geo:10.5,106.7')).toMatch(/^(maps:\/\/|https:\/\/www\.openstreetmap\.org\/)/u)
  expect(parseMatrixCommand({ kind: 'locationSend', roomId, geoUri: ' 10.5, 106.7 ' })).toMatchObject({
    geoUri: 'geo:10.5,106.7'
  })
})
