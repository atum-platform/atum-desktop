import { describe, expect, it } from 'vitest'

import {
  MATRIX_SAVED_MESSAGES_MAX,
  parseMatrixSavedMessages,
  updateMatrixSavedMessages
} from './matrix-saved-messages'

const room = '!saved:test'

const pointer = (index: number, savedAt = index) => ({
  room_id: room,
  event_id: `$event-${index}`,
  saved_at: savedAt
})

describe('Saved messages account data', () => {
  it('normalizes valid records newest first and refuses duplicates or newer schemas', () => {
    expect(parseMatrixSavedMessages({ version: 1, messages: [pointer(1, 10), pointer(2, 20)] }))
      .toEqual({ version: 1, messages: [pointer(2, 20), pointer(1, 10)] })
    expect(parseMatrixSavedMessages({ version: 1, messages: [pointer(1), pointer(1)] })).toBeNull()
    expect(parseMatrixSavedMessages({ version: 2, messages: [] })).toBeNull()
  })

  it('adds one newest pointer, removes exactly that message, and keeps the list bounded', () => {
    const full = {
      version: 1 as const,
      messages: Array.from({ length: MATRIX_SAVED_MESSAGES_MAX }, (_, index) => pointer(index, 1_000 - index))
    }

    const added = updateMatrixSavedMessages(full, { room_id: room, event_id: '$new' }, true, 2_000)

    expect(added.messages).toHaveLength(MATRIX_SAVED_MESSAGES_MAX)
    expect(added.messages[0]).toEqual({ room_id: room, event_id: '$new', saved_at: 2_000 })
    expect(added.messages.at(-1)?.event_id).toBe(`$event-${MATRIX_SAVED_MESSAGES_MAX - 2}`)

    const removed = updateMatrixSavedMessages(added, { room_id: room, event_id: '$new' }, false, 0)
    expect(removed.messages.some(candidate => candidate.event_id === '$new')).toBe(false)
  })

  it('keeps an already-saved message stable instead of changing its saved time or order', () => {
    const content = { version: 1 as const, messages: [pointer(1, 20), pointer(2, 10)] }

    expect(updateMatrixSavedMessages(content, pointer(2), true, 30)).toBe(content)
  })
})
