import { expect, it } from 'vitest'

import type { MatrixMessage } from '../../shared/matrix'

import { matrixFirstUnreadMessageId } from './read-marker'

const message = (id: string, own = false, thread = false) => ({ id, own, thread }) as MatrixMessage

it('places the line at the first received top-level message after the fully-read marker', () => {
  expect(matrixFirstUnreadMessageId([
    message('$read'), message('$own', true), message('$thread', false, true), message('$unread')
  ], '$read')).toBe('$unread')
})

it('uses the count fallback only when the marker is absent from the loaded window', () => {
  expect(matrixFirstUnreadMessageId([message('$unread')], '$older', '$unread')).toBe('$unread')
  expect(matrixFirstUnreadMessageId([message('$read')], '$read', '$read')).toBeUndefined()
})
