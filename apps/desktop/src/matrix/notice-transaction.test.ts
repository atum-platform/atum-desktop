// @vitest-environment node
import type { MatrixClient } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { matrixNoticeEditPayload, matrixStatusNoticeTransaction } from './notice-edit'

const command = { roomId: '!room:test', eventId: '$question', body: 'Working…', statusLine: true as const }
const transactionId = `atum-cn-${'a'.repeat(64)}`

it('uses an explicit bounded cloud transaction only for the first live status notice', async () => {
  const fetchRoomEvent = vi.fn()
  const client = { fetchRoomEvent } as unknown as MatrixClient
  expect((await matrixNoticeEditPayload(client, command))!.transactionId).toBe(matrixStatusNoticeTransaction(command.eventId))
  expect((await matrixNoticeEditPayload(client, { ...command, transactionId }))!.transactionId).toBe(transactionId)
  expect(fetchRoomEvent).not.toHaveBeenCalled()
})

it('rejects transaction overrides on legacy notices, edits and malformed scopes before SDK I/O', async () => {
  const fetchRoomEvent = vi.fn()
  const client = { fetchRoomEvent } as unknown as MatrixClient
  for (const extra of [
    { transactionId, statusLine: undefined }, { transactionId, replaces: '$root', revision: 1 },
    { transactionId: 'arbitrary' }, { transactionId: `atum-cn-${'A'.repeat(64)}` },
    { transactionId: `atum-cn-${'a'.repeat(65)}` }, { transactionId: 1 }
  ]) {
    await expect(matrixNoticeEditPayload(client, { ...command, ...extra } as any)).rejects.toThrow('matrix_command_invalid')
  }
  expect(fetchRoomEvent).not.toHaveBeenCalled()
})
