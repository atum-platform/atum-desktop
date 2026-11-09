import { createClient } from 'matrix-js-sdk'
import { expect, it, vi } from 'vitest'

import { matrixPresence } from './presence'

it('degrades a presence-disabled homeserver to no dots and stops lifecycle retries', async () => {
  const client = createClient({ baseUrl: 'https://matrix.test', userId: '@me:test' })
  const sync = vi.spyOn(client, 'setSyncPresence').mockResolvedValue(undefined)
  const write = vi.spyOn(client, 'setPresence').mockRejectedValue({ errcode: 'M_FORBIDDEN' })
  const presence = matrixPresence(client, '@me:test', () => true, vi.fn())

  expect(presence.snapshot(new Set(['@me:test', '@linh:test'])).users).toEqual([])
  await expect(presence.setAvailability('online')).resolves.toBeUndefined()
  await expect(presence.setAvailability('away')).resolves.toBeUndefined()
  expect(sync).toHaveBeenCalledTimes(2)
  expect(write).toHaveBeenCalledTimes(1)
  await expect(presence.setStatus({ text: 'Busy', dnd: false, expiresAt: Date.now() + 60_000 }))
    .rejects.toThrow('matrix_status_invalid')
  presence.stop()
})
