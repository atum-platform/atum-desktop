import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import { MATRIX_DRIVE_IPC, type MatrixDriveBridge } from '../../shared/matrix-drive'

import type { MatrixDrive } from './drive'
import type { MatrixDriveImport } from './drive-import'
import { validDriveSearchQuery } from './drive-search'
import { parseDriveTaskInput } from './drive-task'

export function registerMatrixDriveIpc(
  ipc: Pick<IpcMain, 'handle'>,
  drive: MatrixDrive,
  requireUi: (event: IpcMainInvokeEvent) => void,
  task?: Pick<MatrixDriveBridge, 'taskStatus' | 'sendTask'>,
  importer?: Pick<MatrixDriveImport, 'importPlan' | 'importRun' | 'importCancel'>
): void {
  ipc.handle(MATRIX_DRIVE_IPC.request, async (event, value: unknown) => {
    requireUi(event)

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('matrix_drive_request_invalid')
    }

    const request = value as Record<string, unknown>

    if (request.kind === 'search' || request.kind === 'cancelSearch') {
      const search = request.kind === 'search'

      if (Object.keys(request).sort().join(',') !== (search ? 'kind,query,requestId,scope' : 'kind,requestId') ||
        typeof request.requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(request.requestId) ||
        (search && (!validDriveSearchQuery(request.query) || !['drive', 'folder'].includes(request.scope as string)))) {
        throw new Error('matrix_drive_request_invalid')
      }

      return search ? drive.search(request.query as string, request.scope as 'drive' | 'folder', request.requestId) : drive.cancelSearch(request.requestId)
    }

    if (request.kind === 'importPlan' && Object.keys(request).join(',') === 'kind' && importer) {
      return importer.importPlan()
    }

    if (
      (request.kind === 'importRun' || request.kind === 'importCancel') &&
      Object.keys(request).sort().join(',') === 'kind,planId' &&
      typeof request.planId === 'string' &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(request.planId) &&
      importer
    ) {
      return importer[request.kind](request.planId)
    }

    if (
      request.kind === 'taskStatus' &&
      Object.keys(request).sort().join(',') === 'kind,roomId' &&
      typeof request.roomId === 'string' &&
      /^![!-~]{1,254}$/u.test(request.roomId) &&
      task
    ) {
      return task.taskStatus(request.roomId)
    }

    if (request.kind === 'sendTask' && Object.keys(request).sort().join(',') === 'input,kind' && task) {
      return task.sendTask(parseDriveTaskInput(request.input))
    }

    if (
      request.kind === 'closePreview' &&
      Object.keys(request).sort().join(',') === 'kind,token' &&
      typeof request.token === 'string' &&
      /^[a-f0-9-]{36}$/.test(request.token)
    ) {
      return drive.closePreview(request.token)
    }

    if (typeof request.kind !== 'string' || Object.keys(request).some(key => key !== 'kind' && key !== 'id')) {
      throw new Error('matrix_drive_request_invalid')
    }

    if (['enter', 'open', 'preview'].includes(request.kind)) {
      if (typeof request.id !== 'string' || !/^[a-f0-9-]{36}$/.test(request.id)) {
        throw new Error('matrix_drive_request_invalid')
      }

      return request.kind === 'enter'
        ? drive.enter(request.id)
        : request.kind === 'preview'
          ? drive.preview(request.id)
          : drive.open(request.id)
    }

    if (request.id !== undefined) {
      throw new Error('matrix_drive_request_invalid')
    }

    switch (request.kind) {
      case 'read':
        return drive.read()

      case 'connect':
        // Never a mode from the window: Turn on is always the person's own `manual` connect.
        return drive.connect()

      case 'chooseFolder':
        return drive.chooseFolder()

      case 'cancelSignIn':
        return drive.cancelSignIn()

      case 'disconnect':
        // The person's Turn off Drive: it also stays off here until their own Turn on.
        return drive.turnOff()

      case 'back':
        return drive.back()

      case 'reveal':
        return drive.reveal()

      default:
        throw new Error('matrix_drive_request_invalid')
    }
  })
}
