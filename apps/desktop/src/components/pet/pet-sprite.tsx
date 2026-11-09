import { memo } from 'react'

import { $petState, $petTempo } from '@/store/pet'

import { PetSpriteCanvas, type PetSpriteProps } from './pet-sprite-canvas'

export { DEFAULT_STATE_ROWS, roamWalkRow } from './pet-sprite-canvas'

/** Legacy activity binding only. Matrix uses the same canvas with its own
 * agent-scoped input, without importing the old profile/session authority. */
export const PetSprite = memo(function PetSprite(props: Omit<PetSpriteProps, 'activity' | 'tempo'>) {
  return <PetSpriteCanvas {...props} activity={$petState} tempo={$petTempo} />
})
