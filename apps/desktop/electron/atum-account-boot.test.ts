import assert from 'node:assert/strict'

import { test } from 'vitest'

import { startAtumRestoreAfterWindow } from './atum-account-boot'

test('a hung hosted restore starts after window creation and cannot block paint', () => {
  const order: string[] = []

  startAtumRestoreAfterWindow({
    createWindow: () => order.push('window'),
    restore: () => {
      order.push('restore')

      return new Promise(() => undefined)
    },
    restoreFailed: () => order.push('failure')
  })

  assert.deepEqual(order, ['window', 'restore'])
})

test('background restore failure emits only the caller-owned closed failure path', async () => {
  const order: string[] = []

  startAtumRestoreAfterWindow({
    createWindow: () => order.push('window'),
    restore: async () => {
      throw new Error('private hosted detail')
    },
    restoreFailed: () => order.push('restore_failed')
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(order, ['window', 'restore_failed'])
})
