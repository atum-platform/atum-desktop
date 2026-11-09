import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import type { MatrixSnapshot } from '../../shared/matrix'
import { MATRIX_LINK_PREVIEW_IPC, type MatrixLinkPreview, matrixLinkPreviewResult } from '../../shared/matrix-link-preview'

const EVENT_ID = /^\$[^\s]{1,255}$/u

/**
 * The room a link preview may be read in: one the person has joined and the window shows without
 * end-to-end encryption. The SDK checks the room's encryption again before it asks the server.
 */
export function matrixLinkPreviewTarget(
  state: Pick<MatrixSnapshot, 'rooms'>,
  roomId: unknown,
  eventId: unknown
): { roomId: string; eventId: string } | undefined {
  if (typeof roomId !== 'string' || typeof eventId !== 'string' || !EVENT_ID.test(eventId)) {
    return undefined
  }

  const room = state.rooms.find(value => value.id === roomId)

  return room && room.membership === 'join' && !room.encrypted ? { roomId, eventId } : undefined
}

/**
 * `matrix:link-previews:read`: one message's preview card. The window names a message, never a
 * link; `ask` forwards the checked target to the person's own SDK and its answer is checked again
 * here. Anything unexpected is no card.
 */
export function registerMatrixLinkPreviewIpc(
  ipc: Pick<IpcMain, 'handle'>,
  state: () => Pick<MatrixSnapshot, 'rooms'>,
  ask: (target: { roomId: string; eventId: string }) => Promise<unknown>,
  requireCaller: (event: IpcMainInvokeEvent) => void
) {
  ipc.handle(MATRIX_LINK_PREVIEW_IPC.read, async (event, roomId: unknown, eventId: unknown): Promise<MatrixLinkPreview | null> => {
    requireCaller(event)

    const target = matrixLinkPreviewTarget(state(), roomId, eventId)

    if (!target) {
      return null
    }

    try {
      return matrixLinkPreviewResult(await ask(target))
    } catch {
      return null
    }
  })
}
