import { expect, it, vi } from 'vitest'

import { createMatrixPresenceLifecycle, MATRIX_AWAY_IDLE_SECONDS, matrixOwnPresenceForActivity } from './presence-lifecycle'

it('maps app focus and system idle to online, away and offline', () => {
  expect(matrixOwnPresenceForActivity({ focused: true, idleSeconds: 0 })).toBe('online')
  expect(matrixOwnPresenceForActivity({ focused: false, idleSeconds: 0 })).toBe('away')
  expect(matrixOwnPresenceForActivity({ focused: true, idleSeconds: MATRIX_AWAY_IDLE_SECONDS })).toBe('away')
  expect(matrixOwnPresenceForActivity({ focused: true, idleSeconds: 0, closing: true })).toBe('offline')
})

it('writes once per account/state, retries failures, and forces offline on exit', async () => {
  const send = vi.fn().mockResolvedValue(undefined)
  const current = { scope: 'one', focused: true, idleSeconds: 0, closing: false }

  const lifecycle = createMatrixPresenceLifecycle({
    current: () => current,
    send,
    interval: () => ({ unref: vi.fn() }) as unknown as ReturnType<typeof setInterval>
  })

  await lifecycle.refresh()
  await lifecycle.refresh()
  expect(send).toHaveBeenCalledTimes(1)

  current.focused = false
  await lifecycle.refresh()
  expect(send).toHaveBeenLastCalledWith('away')

  current.scope = 'two'
  send.mockRejectedValueOnce(new Error('offline'))
  await lifecycle.refresh()
  await lifecycle.refresh()
  expect(send).toHaveBeenLastCalledWith('away')

  await lifecycle.offline()
  expect(send).toHaveBeenLastCalledWith('offline')
  lifecycle.stop()
})
