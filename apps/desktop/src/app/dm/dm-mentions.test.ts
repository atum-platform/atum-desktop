import { describe, expect, it } from 'vitest'

import {
  mentionIsInvocable,
  mentionSearchStart,
  reconcileMentionSelections,
  selectedAtumMention,
  selectedMention
} from './dm-mentions'

describe('DM mentions', () => {
  it('finds a mention query only at a word boundary', () => {
    expect(mentionSearchStart('chào @At', 8)).toBe(5)
    expect(mentionSearchStart('mail@At', 7)).toBeNull()
  })

  it('computes UTF-16 offsets for the selected visible token', () => {
    expect(selectedAtumMention('👋 @Atum giúp mình', 3)).toEqual({
      target: { type: 'assistant', id: 'binh-minh' },
      displayName: 'Atum',
      avatar: '',
      revision: 0,
      startOffset: 3,
      endOffset: 8
    })
  })

  it('retains selected targets after text moves their UTF-16 positions', () => {
    const target = {
      target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-bd7662a5eeb4' },
      revision: 1,
      displayName: 'Bình Minh',
      avatar: '🌅'
    }

    const selection = selectedMention('@Bình Minh chào', 0, target)!

    expect(reconcileMentionSelections('@Bình Minh chào', '🙂 @Bình Minh chào', [selection], 3)).toMatchObject([
      { target: { id: target.target.id }, startOffset: 3, endOffset: 13 }
    ])
  })

  it('drops a deleted token instead of reattaching it to another literal label', () => {
    const target = {
      target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-bd7662a5eeb4' },
      revision: 1,
      displayName: 'Mai',
      avatar: ''
    }

    const selection = selectedMention('literal @Mai then @Mai', 18, target)!

    expect(reconcileMentionSelections('literal @Mai then @Mai', 'literal @Mai then ', [selection], 18)).toEqual([])
  })

  it('keeps duplicate display names bound to their selected UUIDs through an insertion', () => {
    const first = {
      target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-bd7662a5eeb4' },
      revision: 1,
      displayName: 'Mai',
      avatar: ''
    }

    const second = {
      target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-b454f82c5857' },
      revision: 1,
      displayName: 'Mai',
      avatar: ''
    }

    const before = '@Mai và @Mai'

    expect(
      reconcileMentionSelections(
        before,
        '🙂 @Mai và @Mai',
        [selectedMention(before, 0, first)!, selectedMention(before, 8, second)!],
        3
      )
    ).toMatchObject([
      { target: { id: first.target.id }, startOffset: 3 },
      { target: { id: second.target.id }, startOffset: 11 }
    ])
  })

  it('lists shared-room agents for attribution without allowing unavailable agents to be invoked', () => {
    expect(mentionIsInvocable({ availability: 'available' })).toBe(true)
    expect(mentionIsInvocable({ availability: 'assistant_not_owned' })).toBe(false)
    expect(mentionIsInvocable({ availability: 'assistant_not_approved' })).toBe(false)
  })
})

it('deleting the first armed token cannot move it onto an identical trailing literal', () => {
  const target = {
    target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-bd7662a5eeb4' },
    revision: 1,
    displayName: 'Mai',
    avatar: ''
  }

  const before = '@Mai @Mai'
  expect(reconcileMentionSelections(before, '@Mai', [selectedMention(before, 0, target)!], 0)).toEqual([])
})

it('inserting an identical literal before a token keeps the identity on the original token', () => {
  const target = {
    target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-bd7662a5eeb4' },
    revision: 1,
    displayName: 'Mai',
    avatar: ''
  }

  expect(reconcileMentionSelections('@Mai', '@Mai @Mai', [selectedMention('@Mai', 0, target)!], 5)).toMatchObject([
    { target: { id: target.target.id }, startOffset: 5, endOffset: 9 }
  ])
})
