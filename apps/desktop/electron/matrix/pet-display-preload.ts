import { ipcRenderer } from 'electron'

import { MATRIX_CHANNELS } from '../../shared/matrix'
import {
  MATRIX_PET_DISPLAY_ACTION,
  type MatrixPetDisplayAction,
  type MatrixPetDisplayBridge
} from '../../shared/matrix-pet-display'

/** A management intent waits for its exact keyed agent component to mount. */
export function createMatrixPetDisplayBridge(): MatrixPetDisplayBridge {
  let pending: MatrixPetDisplayAction | undefined
  const listeners = new Set<(value: MatrixPetDisplayAction) => boolean>()

  const offer = () => {
    if (!pending) {
      return
    }

    for (const callback of listeners) {
      if (callback(pending)) {
        pending = undefined

        break
      }
    }
  }

  ipcRenderer.on(MATRIX_PET_DISPLAY_ACTION, (_event, value: MatrixPetDisplayAction) => {
    pending = value
    offer()
  })

  return {
    popOut: target => ipcRenderer.invoke(MATRIX_CHANNELS.ui, { kind: 'petPopOut', target }),
    readPreferences: () => ipcRenderer.invoke(MATRIX_CHANNELS.ui, { kind: 'petDisplayRead' }),
    writePreferences: value => ipcRenderer.invoke(MATRIX_CHANNELS.ui, { kind: 'petDisplayWrite', value }),
    onAction(callback) {
      listeners.add(callback)
      offer()

      return () => {
        listeners.delete(callback)
      }
    }
  }
}
