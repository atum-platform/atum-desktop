import { afterEach, expect, it } from 'vitest'

import {
  $matrixDriveTaskSelection,
  clearMatrixDriveTaskSelections,
  clearMatrixDriveTaskSelectionsIfCurrent,
  matrixDriveTaskInputSelections,
  removeMatrixDriveTaskSelection,
  selectMatrixDriveCreate,
  selectMatrixDriveFile,
  setMatrixDriveTaskScope,
  validMatrixDriveLeafName
} from './drive-selection'

const scope = { userId: '@owner:test', deviceId: 'OWNER', roomId: '!assistant:test' }

afterEach(() => setMatrixDriveTaskScope(null, null))

it('keeps opaque selections only for their exact owner, assistant room, and Drive revision', () => {
  setMatrixDriveTaskScope(scope, 7)
  selectMatrixDriveFile('opaque-file', 'notes.txt', 'read')
  expect(matrixDriveTaskInputSelections()).toEqual([{ id: 'opaque-file', mode: 'read' }])

  setMatrixDriveTaskScope({ ...scope, roomId: '!other:test' }, 7)
  expect($matrixDriveTaskSelection.get().selections).toEqual([])

  setMatrixDriveTaskScope(scope, 7)
  selectMatrixDriveFile('opaque-file', 'notes.txt', 'replace')
  setMatrixDriveTaskScope(scope, 8)
  expect($matrixDriveTaskSelection.get().selections).toEqual([])
})

it('keeps at most four selections and validates an explicit output leaf name', () => {
  setMatrixDriveTaskScope(scope, 7)
  ;['one', 'two', 'three', 'four', 'five'].forEach(id => selectMatrixDriveFile(id, id, 'read'))
  expect($matrixDriveTaskSelection.get().selections).toHaveLength(4)
  expect(validMatrixDriveLeafName('summary.md')).toBe(true)
  expect(validMatrixDriveLeafName('../summary.md')).toBe(false)

  removeMatrixDriveTaskSelection('one')
  selectMatrixDriveCreate('folder', 'Reports', 'summary.md')
  expect(matrixDriveTaskInputSelections()).toContainEqual({ id: 'folder', mode: 'create', leafName: 'summary.md' })
  clearMatrixDriveTaskSelections()
  expect($matrixDriveTaskSelection.get().selections).toEqual([])
})

it('does not let a late send clear selections from a newer owner or room', () => {
  setMatrixDriveTaskScope(scope, 7)
  selectMatrixDriveFile('old', 'old.txt', 'read')
  const old = $matrixDriveTaskSelection.get()
  setMatrixDriveTaskScope({ ...scope, roomId: '!new:test' }, 7)
  selectMatrixDriveFile('new', 'new.txt', 'read')
  clearMatrixDriveTaskSelectionsIfCurrent(old)
  expect(matrixDriveTaskInputSelections()).toEqual([{ id: 'new', mode: 'read' }])
  clearMatrixDriveTaskSelectionsIfCurrent($matrixDriveTaskSelection.get())
  expect(matrixDriveTaskInputSelections()).toEqual([])
})
