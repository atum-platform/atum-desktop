import { describe, expect, it } from 'vitest'

import {
  MATRIX_NAV_LIMIT,
  MATRIX_NAV_TRAVEL_MS,
  type MatrixNavHistory,
  recordMatrixNavEntry,
  stepMatrixNavEntry
} from './navigation-history'

const empty: MatrixNavHistory = { entries: [], index: -1 }
const chatA = { screen: 'chat', roomId: '!a' } as const
const chatB = { screen: 'chat', roomId: '!b' } as const
const drive = { screen: 'drive', place: 'recents' } as const

const walk = (...entries: Parameters<typeof recordMatrixNavEntry>[1][]) =>
  entries.reduce((state, entry) => recordMatrixNavEntry(state, entry, 0), empty)

describe('the window history (layout r2 §1)', () => {
  it('keeps one entry per place, in order', () => {
    const state = walk(chatA, chatA, chatB, drive)

    expect(state.entries).toEqual([chatA, chatB, drive])
    expect(state.index).toBe(2)
  })

  it('steps back and forward, and a new place drops what was ahead', () => {
    const back = stepMatrixNavEntry(walk(chatA, chatB, drive), -1, 0)
    expect(back.target).toEqual(chatB)

    const landed = recordMatrixNavEntry(back.state, chatB, 1)
    expect(landed.index).toBe(1)
    expect(stepMatrixNavEntry(landed, 1, 1).target).toEqual(drive)

    const branched = recordMatrixNavEntry(landed, chatA, 2)
    expect(branched.entries).toEqual([chatA, chatB, chatA])
    expect(stepMatrixNavEntry(branched, 1, 2).target).toBeUndefined()
  })

  it('does not record the places a step passes through on its way', () => {
    const { state } = stepMatrixNavEntry(walk(chatA, drive), -1, 0)

    // Chat lands first on its default conversation, then on the one asked for.
    const passing = recordMatrixNavEntry(state, { screen: 'chat', roomId: '!assistant' }, 10)
    expect(passing).toBe(state)
    expect(recordMatrixNavEntry(passing, chatA, 20).entries).toEqual([chatA, drive])
  })

  it('records again once a step that never lands has timed out', () => {
    const { state } = stepMatrixNavEntry(walk(chatA, drive), -1, 0)
    const next = recordMatrixNavEntry(state, chatB, MATRIX_NAV_TRAVEL_MS + 1)

    expect(next.entries).toEqual([chatA, chatB])
    expect(next.travel).toBeUndefined()
  })

  it('refines a screen entry that had no selection yet instead of adding a step', () => {
    const state = walk({ screen: 'chat' }, chatA)

    expect(state.entries).toEqual([chatA])
  })

  it('never grows past its limit', () => {
    let state = empty

    for (let index = 0; index < MATRIX_NAV_LIMIT + 20; index += 1) {
      state = recordMatrixNavEntry(state, { screen: 'chat', roomId: `!${index}` }, 0)
    }

    expect(state.entries).toHaveLength(MATRIX_NAV_LIMIT)
    expect(state.index).toBe(MATRIX_NAV_LIMIT - 1)
  })
})
