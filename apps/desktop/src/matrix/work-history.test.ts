import type { MatrixClient } from 'matrix-js-sdk'
import { describe, expect, it, vi } from 'vitest'

import { readWorkHistory } from './work-history'

function fixture() {
  const e = (id: string, sender = '@owner:test', text = id) => ({
    event_id: id,
    type: 'm.room.message',
    sender,
    content: { msgtype: 'm.text', body: text }
  })

  const request = vi
    .fn()
    .mockResolvedValueOnce({
      chunk: [e('$later'), e('$current'), e('$answer', '@agent:test'), e('$prior')],
      end: 'server-cursor'
    })
    .mockResolvedValueOnce({ chunk: [e('$floor'), e('$cleared')], end: null })

  const client = {
    getRoom: () => ({
      roomId: '!dm:test',
      hasEncryptionStateEvent: () => false,
      getJoinedMembers: () => [{ userId: '@owner:test' }, { userId: '@agent:test' }]
    }),
    getCrypto: () => ({ isEncryptionEnabledInRoom: async () => false }),
    getUserId: () => '@owner:test',
    createMessagesRequest: request,
    setRoom: vi.fn(),
    scrollback: vi.fn()
  } as unknown as MatrixClient

  return { client, request }
}

describe('main-owned background SDK paging', () => {
  it('uses native page cursors, upper cutoff and floor without UI room mutation', async () => {
    const f = fixture()

    const result = await readWorkHistory(f.client, {
      roomId: '!dm:test',
      before: '$current',
      after: null,
      floor: '$floor'
    })

    expect(result.map(m => m.itemId)).toEqual(['$prior', '$answer'])
    expect(result.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(f.request.mock.calls[1][1]).toBe('server-cursor')
    expect(f.client.scrollback).not.toHaveBeenCalled()
  })
  it('refuses an unreached boundary rather than resurrect cleared history', async () => {
    const f = fixture()
    await expect(
      readWorkHistory(f.client, { roomId: '!dm:test', before: '$current', after: null, floor: '$missing' })
    ).rejects.toThrow('boundary')
  })
  it('refuses encrypted rooms before paging', async () => {
    const f = fixture()
    vi.spyOn(f.client, 'getCrypto').mockReturnValue({ isEncryptionEnabledInRoom: async () => true } as never)
    await expect(
      readWorkHistory(f.client, { roomId: '!dm:test', before: '$current', after: null, floor: null })
    ).rejects.toThrow('not_plain')
    expect(f.request).not.toHaveBeenCalled()
  })
})
