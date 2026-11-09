import { expect, it } from 'vitest'

import { MATRIX_STATUS_TEXT_MAX } from '../../shared/matrix-presence'

import { parseMatrixCommand } from './ipc-policy'

it('accepts a bounded expiring status and strips unknown fields', () => {
  const expiresAt = Date.now() + 60_000
  expect(parseMatrixCommand({
    kind: 'setStatus',
    status: { emoji: '🏡', text: 'Working from home', dnd: true, expiresAt, authority: 'admin' },
    roomId: '!ignored:test'
  })).toEqual({
    kind: 'setStatus',
    status: { emoji: '🏡', text: 'Working from home', dnd: true, expiresAt }
  })
  expect(parseMatrixCommand({ kind: 'setStatus', status: null })).toEqual({ kind: 'setStatus', status: null })
})

it('rejects an overlong or non-expiring status at the native boundary', () => {
  expect(() => parseMatrixCommand({
    kind: 'setStatus',
    status: { text: 'a'.repeat(MATRIX_STATUS_TEXT_MAX + 1), dnd: false, expiresAt: Date.now() + 60_000 }
  })).toThrow('matrix_command_invalid')
  expect(() => parseMatrixCommand({
    kind: 'setStatus',
    status: { text: 'busy', dnd: false, expiresAt: Date.now() - 1 }
  })).toThrow('matrix_command_invalid')
})
