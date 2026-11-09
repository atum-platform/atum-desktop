import { atom } from 'nanostores'

import type { PetState } from '../../../shared/pet'
import type { PetCommand } from '../../../shared/pet-engine/types'

import { createPetIntentIntake } from './intake'

export interface PetPresentation {
  lastActiveAt: number
  commands: readonly PetCommand[]
  pickerOpen?: boolean
  menuOpen?: boolean
  glassOpen?: boolean
  pose?: PetState
  position?: { x: number; y: number }
}

const presentations = new Map<
  string,
  { store: ReturnType<typeof atom<PetPresentation>>; users: number; intake: ReturnType<typeof createPetIntentIntake> }
>()

/** Account scope + Matrix agent principal is supplied by the pet's keyed owner. */
export function holdPetPresentation(principal: string, now: number) {
  let entry = presentations.get(principal)

  if (!entry) {
    entry = {
      store: atom<PetPresentation>({ lastActiveAt: now, commands: [] }),
      users: 0,
      intake: createPetIntentIntake()
    }
    presentations.set(principal, entry)
  }

  entry.users += 1
  let released = false

  return {
    store: entry.store,
    intake: entry.intake,
    release() {
      if (released) {
        return
      }

      released = true
      entry.users -= 1

      if (entry.users === 0) {
        presentations.delete(principal)
      }
    }
  }
}

export { petWorkFor } from './presentation'
