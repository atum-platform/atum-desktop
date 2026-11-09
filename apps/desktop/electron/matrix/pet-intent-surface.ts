import type { MatrixPetTarget, MatrixPetView } from '../../shared/matrix-pet'
import { MATRIX_PET_INTENT_PLAYBACK } from '../../shared/matrix-pet-intent'

/** Native main supplies a freshly verified private-room target, never renderer/model facts. */
export async function readMatrixPetIntentSurface(input: {
  owner: string
  target: MatrixPetTarget
  privateRoom: boolean
  excluded?: boolean
  current(): boolean
  read(target: MatrixPetTarget): Promise<MatrixPetView>
}, enabled = MATRIX_PET_INTENT_PLAYBACK): Promise<boolean> {
  if (!enabled || !input.privateRoom || input.excluded || !input.current()) {
    return false
  }

  try {
    const view = await input.read(input.target)

    return input.current() && view.freshness === 'current' &&
      view.selection.owner === input.owner && view.selection.agent === input.target.agent &&
      view.selection.pet?.enabled === true &&
      Boolean(view.selection.pet.ref) &&
      (view.selection.access === 'owned' ||
        (view.selection.access === 'visiting' &&
          Date.parse(view.selection.visitEndsAt ?? '') > Date.parse(view.selection.serverTime))) &&
      !view.visitUnavailable
  } catch {
    // A missing cosmetic capability never prevents an otherwise authorized text turn.
    return false
  }
}
