import { describe, expect, it } from 'vitest'

import {
  buildGroups,
  firstVisibleGroupIndex,
  isVirtualizedGroup,
  LIVE_TAIL_GROUPS,
  type MessageGroup,
  messageRevealBudget,
  parseMessageSignature,
  serializeMessageSignature,
  transcriptPagePrepended,
  transcriptPrependAnchor,
  transcriptScrollTop
} from './list'

const signature = (rows: [string, string, number][]) =>
  serializeMessageSignature(rows.map(([id, role, weight], index) => [index, id, role, weight]))

describe('buildGroups', () => {
  it('returns no groups for an empty signature', () => {
    expect(buildGroups('')).toEqual([])
  })

  it('groups a user message with the assistant turn(s) that follow it', () => {
    const groups = buildGroups(
      signature([
        ['u1', 'user', 1],
        ['a1', 'assistant', 4],
        ['a2', 'assistant', 2],
        ['u2', 'user', 1],
        ['a3', 'assistant', 3]
      ])
    )

    expect(groups).toEqual([
      { id: 'u1', indices: [0, 1, 2], kind: 'turn', weight: 7 },
      { id: 'u2', indices: [3, 4], kind: 'turn', weight: 4 }
    ])
  })

  it('keeps leading non-user messages as standalone groups', () => {
    const groups = buildGroups(
      signature([
        ['s1', 'system', 1],
        ['a0', 'assistant', 2],
        ['u1', 'user', 1],
        ['a1', 'assistant', 5]
      ])
    )

    expect(groups).toEqual([
      { id: 's1', index: 0, kind: 'standalone', weight: 1 },
      { id: 'a0', index: 1, kind: 'standalone', weight: 2 },
      { id: 'u1', indices: [2, 3], kind: 'turn', weight: 6 }
    ])
  })

  it('defaults a missing/zero weight to 1', () => {
    const groups = buildGroups(serializeMessageSignature([[0, 'a', 'assistant', 0]]))

    expect(groups).toEqual([{ id: 'a', index: 0, kind: 'standalone', weight: 1 }])
  })

  it('preserves two distinct colon-rich history IDs without corrupting role or weight', () => {
    const encoded = signature([
      ['app-history:moon:web:reading:owner', 'user', 2],
      ['app-history:moon:web:reading:answer', 'assistant', 3]
    ])

    expect(parseMessageSignature(encoded)).toEqual([
      { id: 'app-history:moon:web:reading:owner', index: 0, role: 'user', weight: 2 },
      { id: 'app-history:moon:web:reading:answer', index: 1, role: 'assistant', weight: 3 }
    ])
    expect(buildGroups(encoded)).toEqual([
      { id: 'app-history:moon:web:reading:owner', indices: [0, 1], kind: 'turn', weight: 5 }
    ])
  })

  it('keeps Matrix-style delimiter characters and newlines through ordinary turn grouping', () => {
    const encoded = signature([
      ['$room:event/one|part:[x]\ncontinued', 'user', 4],
      ['$room:event/two?part="y"', 'assistant', 5],
      ['$next:user:event', 'user', 2],
      ['$next:assistant:event', 'assistant', 7]
    ])

    expect(buildGroups(encoded)).toEqual([
      { id: '$room:event/one|part:[x]\ncontinued', indices: [0, 1], kind: 'turn', weight: 9 },
      { id: '$next:user:event', indices: [2, 3], kind: 'turn', weight: 9 }
    ])
    expect(parseMessageSignature(encoded).map(message => message.id)).toEqual([
      '$room:event/one|part:[x]\ncontinued',
      '$room:event/two?part="y"',
      '$next:user:event',
      '$next:assistant:event'
    ])
  })
})

describe('firstVisibleGroupIndex', () => {
  const group = (id: string, weight: number): MessageGroup => ({ id, index: 0, kind: 'standalone', weight })

  it('shows everything when total weight fits the budget', () => {
    const groups = [group('a', 10), group('b', 10), group('c', 10)]

    expect(firstVisibleGroupIndex(groups, 100)).toBe(0)
  })

  it('walks newest-first and hides everything before the turn that meets the budget', () => {
    const groups = [group('old', 50), group('mid', 30), group('new', 30)]

    // newest-first: 30 (new) < 60, +30 (mid) = 60 >= 60 → mid is the first
    // visible group, old is hidden.
    expect(firstVisibleGroupIndex(groups, 60)).toBe(1)
  })

  it('keeps whole turns intact — the turn that crosses the budget stays visible', () => {
    const groups = [group('old', 5), group('huge', 500)]

    expect(firstVisibleGroupIndex(groups, 60)).toBe(1)
  })

  it('returns groups.length for an empty list', () => {
    expect(firstVisibleGroupIndex([], 60)).toBe(0)
  })
})

describe('messageRevealBudget', () => {
  it('reveals the target turn and the newer tail without rendering older turns', () => {
    const groups: MessageGroup[] = [
      { id: 'old', index: 0, kind: 'standalone', weight: 20 },
      { id: 'target', indices: [1, 2], kind: 'turn', weight: 40 },
      { id: 'new', index: 3, kind: 'standalone', weight: 10 }
    ]

    expect(messageRevealBudget(groups, 2)).toBe(50)
    expect(messageRevealBudget(groups, 0)).toBe(70)
    expect(messageRevealBudget(groups, 99)).toBe(0)
  })
})

describe('transcript prepend anchoring', () => {
  it('keeps the same content under the viewport when an older page is prepended', () => {
    const anchor = transcriptPrependAnchor(1_200, 20)

    expect(anchor).toBe(1_180)
    expect(transcriptScrollTop(1_500, anchor)).toBe(320)
  })

  it('recognizes a prepend without mistaking a live append for the page', () => {
    const previous = new Set(['$oldest', '$next'])

    expect(transcriptPagePrepended(previous, ['$older', '$oldest', '$next'])).toBe(true)
    expect(transcriptPagePrepended(previous, ['$next', '$new'])).toBe(false)
    expect(transcriptPagePrepended(previous, ['$older', '$next', '$new'])).toBe(true)
    expect(transcriptPagePrepended(previous, ['$foreign'])).toBe(false)
  })
})

describe('isVirtualizedGroup', () => {
  it('never virtualizes the newest turns (the live tail)', () => {
    const count = 20

    for (let i = count - LIVE_TAIL_GROUPS; i < count; i++) {
      expect(isVirtualizedGroup(i, count)).toBe(false)
    }
  })

  it('virtualizes older turns that sit before the live tail', () => {
    const count = 20

    expect(isVirtualizedGroup(0, count)).toBe(true)
    expect(isVirtualizedGroup(count - LIVE_TAIL_GROUPS - 1, count)).toBe(true)
  })

  it('keeps every turn rendered when the whole transcript fits in the tail', () => {
    const count = LIVE_TAIL_GROUPS

    for (let i = 0; i < count; i++) {
      expect(isVirtualizedGroup(i, count)).toBe(false)
    }
  })

  it('honors a custom tail size', () => {
    expect(isVirtualizedGroup(5, 10, 3)).toBe(true)
    expect(isVirtualizedGroup(7, 10, 3)).toBe(false)
  })
})
