import { describe, expect, it } from 'vitest'

import {
  boundedMatrixDraftText,
  MATRIX_DRAFT_TEXT_MAX_BYTES,
  MATRIX_DRAFTS_MAX,
  matrixDraftText,
  parseMatrixDrafts,
  pruneMatrixDrafts,
  updateMatrixDrafts
} from './matrix-drafts'

const roomId = '!drafts:test'

describe('Matrix draft account data', () => {
  it('bounds UTF-8 text without splitting characters and evicts the oldest draft', () => {
    const long = '字'.repeat(MATRIX_DRAFT_TEXT_MAX_BYTES)
    const bounded = boundedMatrixDraftText(long)

    expect(new TextEncoder().encode(bounded).byteLength).toBeLessThanOrEqual(MATRIX_DRAFT_TEXT_MAX_BYTES)
    expect(long.startsWith(bounded)).toBe(true)

    let content = { version: 1 as const, drafts: [] }

    for (let index = 0; index <= MATRIX_DRAFTS_MAX; index++) {
      content = updateMatrixDrafts(content, { roomId: `!room-${index}:test` }, `draft ${index}`, index)
    }

    expect(content.drafts).toHaveLength(MATRIX_DRAFTS_MAX)
    expect(matrixDraftText({ records: content.drafts, writable: true }, { roomId: '!room-0:test' })).toBe('')
    expect(matrixDraftText({ records: content.drafts, writable: true }, { roomId: `!room-${MATRIX_DRAFTS_MAX}:test` }))
      .toBe(`draft ${MATRIX_DRAFTS_MAX}`)
  })

  it('stores only text and target identity, never local IME or selection state', () => {
    const content = updateMatrixDrafts(
      { version: 1, drafts: [] },
      { roomId, threadRootId: '$root' },
      'đang soạn',
      100
    )
    const wire = {
      ...content,
      drafts: content.drafts.map(draft => ({
        ...draft,
        composing: true,
        selection_start: 2,
        selection_end: 5
      }))
    }

    expect(parseMatrixDrafts(wire)).toEqual(content)
    expect(content.drafts[0]).toEqual({
      room_id: roomId,
      thread_root_id: '$root',
      text: 'đang soạn',
      updated_at: 100
    })
  })

  it('clears a sent draft and prunes rooms outside the current joined audience', () => {
    const first = updateMatrixDrafts({ version: 1, drafts: [] }, { roomId }, 'send me', 2)
    const second = updateMatrixDrafts(first, { roomId: '!gone:test' }, 'private', 3)
    const pruned = pruneMatrixDrafts(second, new Set([roomId]))
    const cleared = updateMatrixDrafts(pruned, { roomId }, '', 4)

    expect(pruned.drafts.map(draft => draft.room_id)).toEqual([roomId])
    expect(cleared).toEqual({ version: 1, drafts: [] })
  })
})
