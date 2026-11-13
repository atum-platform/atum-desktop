import type { IpcMainInvokeEvent } from 'electron'
import { expect, it, vi } from 'vitest'

import { MATRIX_DRIVE_IPC } from '../../shared/matrix-drive'

import type { MatrixDrive } from './drive'
import { registerMatrixDriveIpc } from './drive-ipc'

it('search accepts names and closed scopes only, and cancellation is UI-bound', async () => {
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
  const ipc = { handle: vi.fn((_channel, callback) => (handler = callback)) }
  const drive = { search: vi.fn(), cancelSearch: vi.fn() }
  const requireUi = vi.fn()
  registerMatrixDriveIpc(ipc, drive as unknown as MatrixDrive, requireUi)
  const event = {} as IpcMainInvokeEvent
  const requestId = '00000000-0000-4000-8000-11e594f48195'
  const request = { kind: 'search', query: 'report', scope: 'drive', requestId }
  await handler(event, request)
  await handler(event, { kind: 'cancelSearch', requestId })
  expect(drive.search).toHaveBeenCalledExactlyOnceWith('report', 'drive', requestId)
  expect(drive.cancelSearch).toHaveBeenCalledExactlyOnceWith(requestId)

  for (const invalid of [
    { ...request, root: '../outside' }, { ...request, scope: '../outside' }, { ...request, query: '../outside' },
    { ...request, path: '/outside' }, { ...request, requestId: '../outside' },
    { ...request, query: 'a'.repeat(257) }, { kind: 'cancelSearch', requestId, all: true }
  ]) {await expect(handler(event, invalid)).rejects.toThrow('invalid')}

  requireUi.mockImplementation(() => { throw new Error('caller denied') })
  await expect(handler(event, request)).rejects.toThrow('caller denied')
  await expect(handler(event, { kind: 'cancelSearch', requestId })).rejects.toThrow('caller denied')
  expect(drive.search).toHaveBeenCalledOnce()
})

it('import chooses only through main and accepts only a cached opaque intent id', async () => {
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>

  const ipc = {
    handle: vi.fn((_channel, callback) => {
      handler = callback
    })
  }

  const requireUi = vi.fn()

  const importer = {
    importPlan: vi.fn(async () => ({ state: 'cancelled' as const })),
    importRun: vi.fn(async () => ({ state: 'completed' as const, added: 1 })),
    importCancel: vi.fn(async () => ({ state: 'cancelled' as const, added: 0 }))
  }

  registerMatrixDriveIpc(ipc, {} as MatrixDrive, requireUi, undefined, importer)
  const event = {} as IpcMainInvokeEvent
  const planId = '00000000-0000-4000-8000-11e594f48195'
  await handler(event, { kind: 'importPlan' })
  await handler(event, { kind: 'importRun', planId })
  await handler(event, { kind: 'importCancel', planId })
  expect(importer.importPlan).toHaveBeenCalledExactlyOnceWith()
  expect(importer.importRun).toHaveBeenCalledExactlyOnceWith(planId)
  expect(importer.importCancel).toHaveBeenCalledExactlyOnceWith(planId)

  for (const invalid of [
    { kind: 'importPlan', paths: ['/synthetic/private'] },
    { kind: 'importRun', planId, destination: '/synthetic/private' },
    { kind: 'importRun', planId: '../other' },
    { kind: 'importCancel', planId, mode: 'force' },
    { kind: 'importRun' }
  ]) {
    await expect(handler(event, invalid)).rejects.toThrow('matrix_drive_request_invalid')
  }

  requireUi.mockImplementation(() => {
    throw new Error('caller denied')
  })
  await expect(handler(event, { kind: 'importRun', planId })).rejects.toThrow('caller denied')
  expect(importer.importRun).toHaveBeenCalledOnce()
})

it('admits only the UI and opaque typed task intent at the actual Drive IPC handler', async () => {
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>

  const ipc = {
    handle: vi.fn((channel, callback) => {
      expect(channel).toBe(MATRIX_DRIVE_IPC.request)
      handler = callback
    })
  }

  const requireUi = vi.fn()

  const task = {
    taskStatus: vi.fn(async () => ({ state: 'ready' as const })),
    sendTask: vi.fn(async () => ({ state: 'sent' as const, eventId: '$ack' }))
  }

  registerMatrixDriveIpc(ipc, {} as MatrixDrive, requireUi, task)
  const event = {} as IpcMainInvokeEvent
  await handler(event, { kind: 'taskStatus', roomId: '!private:test' })
  expect(task.taskStatus).toHaveBeenCalledWith('!private:test')

  const input = {
    roomId: '!private:test',
    body: 'Read this',
    revision: 1,
    selections: [{ id: '00000000-0000-4000-8000-11e594f48195', mode: 'read' }]
  }

  await handler(event, { kind: 'sendTask', input })
  expect(task.sendTask).toHaveBeenCalledExactlyOnceWith(input)

  for (const value of [
    { kind: 'sendTask', input, token: 'forged' },
    { kind: 'taskStatus', roomId: '!private:test', endpoint: 'https://elsewhere.test' },
    { kind: 'sendTask', input: { ...input, selections: [{ ...input.selections[0], resource: {} }] } }
  ]) {
    await expect(handler(event, value)).rejects.toThrow('invalid')
  }

  requireUi.mockImplementation(() => {
    throw new Error('caller denied')
  })
  await expect(handler(event, { kind: 'sendTask', input })).rejects.toThrow('caller denied')
  expect(task.sendTask).toHaveBeenCalledTimes(1)
})

it('admits preview leases only by opaque row and lease ids', async () => {
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>
  const ipc = { handle: vi.fn((_channel, callback) => (handler = callback)) }
  const drive = { preview: vi.fn(() => ({ token: 'lease', kind: 'unsupported' })), closePreview: vi.fn() }
  registerMatrixDriveIpc(ipc, drive as unknown as MatrixDrive, vi.fn())
  const event = {} as IpcMainInvokeEvent
  const id = '00000000-0000-4000-8000-11e594f48195'
  const token = '00000000-0000-4000-8000-e79acd97ac88'

  await handler(event, { kind: 'preview', id })
  await handler(event, { kind: 'closePreview', token })
  expect(drive.preview).toHaveBeenCalledWith(id)
  expect(drive.closePreview).toHaveBeenCalledWith(token)

  for (const invalid of [
    { kind: 'preview', id: '/home/example/plan.pdf' },
    { kind: 'preview', id, path: '/home/example/plan.pdf' },
    { kind: 'closePreview', token: '/home/example/plan.pdf' }
  ]) {
    await expect(handler(event, invalid)).rejects.toThrow('matrix_drive_request_invalid')
  }
})

it('admits Choose another folder and Cancel as bare requests from the UI only, never with a path, URL or mode', async () => {
  let handler!: (event: IpcMainInvokeEvent, value: unknown) => Promise<unknown>

  const ipc = {
    handle: vi.fn((_channel, callback) => {
      handler = callback
    })
  }

  const view = { state: 'disconnected', revision: 1, rows: [], canGoBack: false, truncated: false }

  const drive = {
    connect: vi.fn(async () => view),
    chooseFolder: vi.fn(async () => view),
    cancelSignIn: vi.fn(async () => view),
    turnOff: vi.fn(async () => view),
    disconnect: vi.fn(async () => view)
  }

  const requireUi = vi.fn()
  registerMatrixDriveIpc(ipc, drive as unknown as MatrixDrive, requireUi)
  const event = {} as IpcMainInvokeEvent

  await handler(event, { kind: 'chooseFolder' })
  await handler(event, { kind: 'cancelSignIn' })
  await handler(event, { kind: 'connect' })
  await handler(event, { kind: 'disconnect' })
  expect(drive.chooseFolder).toHaveBeenCalledExactlyOnceWith()
  expect(drive.cancelSignIn).toHaveBeenCalledExactlyOnceWith()
  // Turn on takes no mode from the window: it is always the person's own connect.
  expect(drive.connect).toHaveBeenCalledExactlyOnceWith()
  // Turn off from the window is the person's own: Drive stays off here (a sign-out's disconnect
  // is main's alone).
  expect(drive.turnOff).toHaveBeenCalledExactlyOnceWith()
  expect(drive.disconnect).not.toHaveBeenCalled()

  for (const value of [
    { kind: 'chooseFolder', id: '/home/example/Documents' },
    { kind: 'chooseFolder', root: '/home/example/Documents' },
    { kind: 'cancelSignIn', id: '00000000-0000-4000-8000-11e594f48195' },
    { kind: 'connect', mode: 'automatic' },
    { kind: 'choose' }
  ]) {
    await expect(handler(event, value)).rejects.toThrow('invalid')
  }

  // A browser sign-in is never reachable from the window: Drive is automatic, with the app's
  // credential, and the legacy Open again request is refused rather than opening a page.
  await expect(handler(event, { kind: 'reopenSignIn' })).rejects.toThrow('matrix_drive_request_invalid')
  expect(drive.chooseFolder).toHaveBeenCalledOnce()
  expect(drive.cancelSignIn).toHaveBeenCalledOnce()
  expect(drive.connect).toHaveBeenCalledOnce()

  requireUi.mockImplementation(() => {
    throw new Error('caller denied')
  })

  for (const kind of ['chooseFolder', 'cancelSignIn']) {
    await expect(handler(event, { kind })).rejects.toThrow('caller denied')
  }

  expect(drive.chooseFolder).toHaveBeenCalledOnce()
  expect(drive.cancelSignIn).toHaveBeenCalledOnce()
})
