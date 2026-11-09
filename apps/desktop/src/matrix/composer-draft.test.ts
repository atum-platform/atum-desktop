import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearLocalMatrixDrafts,
  clearLocalMatrixRoomDrafts,
  createMatrixDraftWriter,
  localMatrixDraft,
  setLocalMatrixDraft
} from './composer-draft'

afterEach(() => {
  clearLocalMatrixDrafts()
  vi.useRealTimers()
})

describe('composer draft writer', () => {
  it('debounces writes and makes the successful-send clear win', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const writer = createMatrixDraftWriter(async text => {
      writes.push(text)
    }, '', 500)

    writer.schedule('first')
    writer.schedule('Ship Tuesday')
    await vi.advanceTimersByTimeAsync(500)
    await writer.clear()

    expect(writes).toEqual(['Ship Tuesday', ''])
  })

  it('flushes the latest value when a room closes before the debounce', async () => {
    vi.useFakeTimers()
    const write = vi.fn(async (_text: string) => {})
    const writer = createMatrixDraftWriter(write, '', 500)

    writer.schedule('Keep this draft')
    await writer.flush()

    expect(write).toHaveBeenCalledExactlyOnceWith('Keep this draft')
  })

  it('reports durable pending and save failure quietly, then settles when sync catches up', async () => {
    const statuses: string[] = []
    const pending = createMatrixDraftWriter(
      async () => ({ status: 'pending' }),
      '',
      0,
      status => statuses.push(status)
    )

    pending.schedule('Offline notes')
    await pending.flush()
    expect(statuses).toEqual(['pending', 'pending'])

    pending.reconcile('Offline notes')
    expect(statuses.at(-1)).toBe('saved')

    const failed = createMatrixDraftWriter(
      async () => {throw new Error('matrix_draft_storage_unavailable')},
      '',
      0,
      status => statuses.push(status)
    )
    failed.schedule('Not durable')
    await expect(failed.flush()).rejects.toThrow('matrix_draft_storage_unavailable')
    expect(statuses.at(-1)).toBe('failed')
  })
})

it('clears a deleted room’s local drafts and threads while retaining another room', () => {
  const identity = { userId: '@self:test', deviceId: 'SELF' }
  const room = { roomId: '!gone:test' }
  const thread = { ...room, threadRootId: '$thread' }
  const other = { roomId: '!kept:test' }
  for (const target of [room, thread, other]) {
    setLocalMatrixDraft(identity, target, 'draft')
  }
  clearLocalMatrixRoomDrafts(room.roomId)
  expect(localMatrixDraft(identity, room)).toBeUndefined()
  expect(localMatrixDraft(identity, thread)).toBeUndefined()
  expect(localMatrixDraft(identity, other)).toBe('draft')
})
