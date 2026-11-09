import { atom } from 'nanostores'

import type { MatrixDriveSelection } from '../../shared/matrix-drive'

export interface MatrixDriveTaskScope {
  deviceId: string
  roomId: string
  userId: string
}

export type MatrixDriveTaskSelection = MatrixDriveSelection & { name: string }

export interface MatrixDriveTaskSelectionState {
  revision: number | null
  scope: MatrixDriveTaskScope | null
  selections: MatrixDriveTaskSelection[]
}

const empty: MatrixDriveTaskSelectionState = { revision: null, scope: null, selections: [] }
export const $matrixDriveTaskSelection = atom<MatrixDriveTaskSelectionState>(empty)

export function sameMatrixDriveTaskScope(a: MatrixDriveTaskScope | null, b: MatrixDriveTaskScope | null): boolean {
  return a?.userId === b?.userId && a?.deviceId === b?.deviceId && a?.roomId === b?.roomId
}

/** Opaque Drive row IDs are intentionally memory-only and bound to one owner + assistant room. */
export function setMatrixDriveTaskScope(scope: MatrixDriveTaskScope | null, revision: number | null): void {
  const current = $matrixDriveTaskSelection.get()

  if (sameMatrixDriveTaskScope(current.scope, scope) && current.revision === revision) {
    return
  }

  $matrixDriveTaskSelection.set({ scope, revision, selections: [] })
}

export function clearMatrixDriveTaskSelections(): void {
  const current = $matrixDriveTaskSelection.get()

  if (current.selections.length) {
    $matrixDriveTaskSelection.set({ ...current, selections: [] })
  }
}

/** A late send cannot clear selections staged for a newer room or owner. */
export function clearMatrixDriveTaskSelectionsIfCurrent(expected: MatrixDriveTaskSelectionState): void {
  if ($matrixDriveTaskSelection.get() === expected) {
    clearMatrixDriveTaskSelections()
  }
}

export function validMatrixDriveLeafName(value: string): boolean {
  return (
    value === value.trim() &&
    value !== '' &&
    value !== '.' &&
    value !== '..' &&
    [...value].length <= 128 &&
    ![...value].some(character => character === '/' || character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
}

function replaceSelection(selection: MatrixDriveTaskSelection): void {
  const current = $matrixDriveTaskSelection.get()
  const without = current.selections.filter(value => value.id !== selection.id)

  if (without.length >= 4) {
    return
  }

  $matrixDriveTaskSelection.set({ ...current, selections: [...without, selection] })
}

export function selectMatrixDriveFile(id: string, name: string, mode: 'read' | 'replace'): void {
  replaceSelection({ id, name, mode })
}

export function selectMatrixDriveCreate(id: string, folderName: string, leafName: string): void {
  if (!validMatrixDriveLeafName(leafName)) {
    return
  }

  replaceSelection({ id, name: `${folderName} · ${leafName}`, mode: 'create', leafName })
}

export function removeMatrixDriveTaskSelection(id: string): void {
  const current = $matrixDriveTaskSelection.get()
  const selections = current.selections.filter(value => value.id !== id)

  if (selections.length !== current.selections.length) {
    $matrixDriveTaskSelection.set({ ...current, selections })
  }
}

export function matrixDriveTaskInputSelections(state = $matrixDriveTaskSelection.get()): MatrixDriveSelection[] {
  return state.selections.map(value =>
    value.mode === 'create' ? { id: value.id, mode: value.mode, leafName: value.leafName } : { id: value.id, mode: value.mode }
  )
}
