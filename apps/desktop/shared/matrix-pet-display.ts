import type { MatrixPetTarget } from './matrix-pet'

export const MATRIX_PET_DISPLAY_ACTION = 'matrix:pet-display:action'
export interface MatrixPetDisplayAction {
  target: MatrixPetTarget
  action: 'change' | 'size' | 'store' | 'settings'
}

export interface MatrixPetDisplayPreferences {
  showReplyExcerpt: boolean
}

/** Trusted Atum UI controls; never exposed in the floating pet's preload. */
export interface MatrixPetDisplayBridge {
  popOut(target: MatrixPetTarget): Promise<void>
  readPreferences(): Promise<MatrixPetDisplayPreferences>
  writePreferences(value: MatrixPetDisplayPreferences): Promise<MatrixPetDisplayPreferences>
  /** Return true only when this mounted agent's UI consumed the native request. */
  onAction(callback: (value: MatrixPetDisplayAction) => boolean): () => void
}
