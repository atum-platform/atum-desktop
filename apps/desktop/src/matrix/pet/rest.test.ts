import { afterEach, describe, expect, it } from 'vitest'

import type { PetEngineState, PetWorld } from '../../../shared/pet-engine/types'

import { defaultPetLanding, petRestingPlace, recallPetRest, rememberPetRest, settlePet } from './rest'

const world: PetWorld = {
  width: 800,
  floorY: 700,
  free: [{ left: 0, right: 700 }],
  perches: [{ id: 'composer:0:0', left: 100, right: 600, y: 560 }]
}

afterEach(() => {
  window.localStorage.clear()
})

describe('where the companion rests', () => {
  it('keeps her resting place per agent across a remount, and an unreadable one is no place', () => {
    rememberPetRest('["account","agent-a"]', { x: 310, y: 700 })
    rememberPetRest('["account","agent-b"]', { perchId: 'composer:0:0', x: 220, y: 560 })

    expect(recallPetRest('["account","agent-a"]')).toEqual({ x: 310, y: 700 })
    expect(recallPetRest('["account","agent-b"]')).toEqual({ perchId: 'composer:0:0', x: 220, y: 560 })
    expect(recallPetRest('["account","agent-c"]')).toBeUndefined()

    window.localStorage.setItem(
      `atum.matrix.pet-stage-position.v1:${encodeURIComponent('["account","agent-a"]')}`,
      '{"x":"left"}'
    )
    expect(recallPetRest('["account","agent-a"]')).toBeUndefined()
  })

  it('puts her back on the ledge she was on even after it moved, and on the floor once it is gone', () => {
    // The composer grew a line: its top is higher than when she settled there.
    const grown = { ...world, perches: [{ ...world.perches[0]!, y: 530 }] }
    expect(settlePet(grown, 89, { perchId: 'composer:0:0', x: 220, y: 560 })).toEqual({
      perchId: 'composer:0:0',
      x: 220,
      y: 530
    })

    expect(settlePet({ ...world, perches: [] }, 89, { perchId: 'composer:0:0', x: 220, y: 560 })).toEqual({
      x: 220,
      y: 700
    })

    // A plain point lands on the nearest walkable surface, clamped into it.
    expect(settlePet(world, 89, { x: 900, y: 100_000 })).toEqual({ x: 700, y: 700 })
    expect(defaultPetLanding(world, 89)).toEqual({ x: 127.97999999999999, y: 700 })
  })

  it('starts on the real floor while leaving the composer rim available', () => {
    const landing = defaultPetLanding(world, 89)

    expect(landing.perchId).toBeUndefined()
    expect(landing.y).toBe(world.floorY)
    expect(world.free.some(span => landing.x >= span.left && landing.x <= span.right)).toBe(true)
  })

  it('resumes a walk where it was and a leap where it lands', () => {
    const walking = {
      x: 412.5,
      y: 700,
      intent: { pose: 'run', mirror: true, targetX: 600 },
      motion: { fromX: 300, fromY: 700, toX: 600, toY: 700, startedAt: 0, durationMs: 5000, arcHeight: 0 }
    } as Pick<PetEngineState, 'x' | 'y' | 'perchId' | 'motion' | 'intent'>

    expect(petRestingPlace(walking)).toEqual({ x: 412.5, y: 700 })

    const leaping = {
      x: 205,
      y: 590,
      intent: { pose: 'jump', mirror: true, targetX: 216, hopToPerch: 'composer:0:0' },
      motion: { fromX: 200, fromY: 700, toX: 216, toY: 560, startedAt: 0, durationMs: 460, arcHeight: 24, kind: 'leap' }
    } as Pick<PetEngineState, 'x' | 'y' | 'perchId' | 'motion' | 'intent'>

    expect(petRestingPlace(leaping)).toEqual({ perchId: 'composer:0:0', x: 216, y: 560 })
  })
})
