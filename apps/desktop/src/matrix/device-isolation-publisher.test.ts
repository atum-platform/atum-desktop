import { createClient, EventType, MatrixEvent, Room } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { MATRIX_APP_GROUP_BINDING, MATRIX_APP_GROUP_TYPE } from '../../shared/matrix-app-room'

import { publishMatrixGroupNotice, publishMatrixNotice, publishMatrixResult } from './publish-result'

it.each(['all', 'signed'] as const)('all actual publication overrides respect the %s policy', async mode => {
  for (const roomKind of ['ordinary', 'bound-app'] as const) {
    for (const publication of ['result', 'notice', 'disclosure'] as const) {
      const client = createClient({
        baseUrl: 'https://matrix.test',
        userId: '@app:test'
      })

      const room = new Room('!group:test', client, client.getSafeUserId())
      room.updateMyMembership('join')

      const event = (type: EventType, state_key: string, content: Record<string, unknown>, event_id: string) =>
        new MatrixEvent({
          type,
          state_key,
          room_id: room.roomId,
          sender: '@owner:test',
          event_id,
          content
        })

      room.currentState.setStateEvents([
        event(
          EventType.RoomCreate,
          '',
          roomKind === 'bound-app'
            ? {
                type: MATRIX_APP_GROUP_TYPE,
                [MATRIX_APP_GROUP_BINDING]: { app: '@app:test' }
              }
            : {},
          '$create'
        ),
        event(EventType.RoomEncryption, '', { algorithm: 'm.megolm.v1.aes-sha2' }, '$encryption'),
        ...['@app:test', '@owner:test', '@peer:test'].map((userId, i) =>
          event(EventType.RoomMember, userId, { membership: 'join' }, `$member-${i}`)
        )
      ])
      client.store.storeRoom(room)
      const override = vi.spyOn(room, 'setBlacklistUnverifiedDevices')

      const send = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$posted' })

      const target = {
        roomId: room.roomId,
        eventId: '$request',
        body: 'Fixed synthetic copy',
        ...(roomKind === 'ordinary' ? { group: true as const } : {})
      }

      if (roomKind === 'bound-app' && publication === 'disclosure') {
        await expect(publishMatrixGroupNotice(client, { kind: 'publishGroupNotice', ...target }, mode)).rejects.toThrow(
          'matrix_group_room_required'
        )
        expect(override).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()

        continue
      }

      if (publication === 'result') {
        await publishMatrixResult(
          client,
          {
            kind: 'publishResult',
            ...target,
            invocationId: 'invocation',
            transactionId: 'transaction'
          },
          mode
        )
      } else if (publication === 'notice') {
        await publishMatrixNotice(client, { kind: 'publishNotice', ...target }, () => true, mode)
      } else {
        await publishMatrixGroupNotice(client, { kind: 'publishGroupNotice', ...target }, mode)
      }

      const legacyOverride = mode === 'all' && (roomKind === 'ordinary' || publication === 'result')

      expect(override.mock.calls).toEqual(legacyOverride ? [[false]] : [])
      expect(send).toHaveBeenCalledOnce()
      expect(room.getBlacklistUnverifiedDevices()).toBe(legacyOverride ? false : null)
    }
  }
})
