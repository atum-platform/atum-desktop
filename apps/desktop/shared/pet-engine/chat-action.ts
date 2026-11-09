import type { AtumPetChatAction } from '../pet-chat/atum-pet-chat'

import type { PetCommand } from './types'

/** One allowlisted chat action, applied as a one-shot engine command. `come` is
 * already folded into `{action:'go', place:'center'}` by the provider; an unknown
 * action (never produced by the parser) is dropped rather than guessed. */
export function petChatCommand(action: AtumPetChatAction | null | undefined): PetCommand | undefined {
  if (!action) {
    return undefined
  }

  if (action.action === 'go') {
    return { action: 'go', place: action.place }
  }

  if (
    action.action === 'sit' ||
    action.action === 'lounge' ||
    action.action === 'sleep' ||
    action.action === 'jump' ||
    action.action === 'wave'
  ) {
    return { action: action.action }
  }

  return undefined
}
