import { describe, expect, it } from 'vitest'

import { DEFAULT_SURFACES, parseSurfaceSet, SURFACE_IDS, type SurfaceState } from '@/store/surfaces'

import { railSurfaceState } from './rail-surfaces'

describe('railSurfaceState', () => {
  it('selects every state from the projection rather than recomputing feature gates', () => {
    for (const state of ['on', 'needs_setup', 'coming_soon', 'needs_update', 'hidden'] as SurfaceState[]) {
      for (const id of SURFACE_IDS) {
        const places = parseSurfaceSet(
          Object.values(DEFAULT_SURFACES).map(row =>
            row.id === id ? { ...row, state, ...(state === 'hidden' ? { reason: 'retired' } : {}) } : row
          )
        )!

        expect(railSurfaceState(id, places)).toBe(state)

        for (const other of SURFACE_IDS.filter(value => value !== id)) {
          expect(railSurfaceState(other, places)).toBe(DEFAULT_SURFACES[other].state)
        }
      }
    }
  })
})
