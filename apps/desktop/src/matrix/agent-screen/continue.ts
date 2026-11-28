/**
 * The owner's "carry on" after a confirmed hand back, sent as their own visible message through
 * the chat's own send path (the same one the composer uses), so it is an ordinary new turn: no
 * synthetic prompt, nothing cached rewritten. The Screen sets it; the chat on screen sends it once.
 */
import { atom } from 'nanostores'

export interface MatrixScreenContinue {
  /** Unique per confirmed release, so the same request is never sent twice. */
  id: string
  roomId: string
  text: string
}

export const $matrixScreenContinue = atom<MatrixScreenContinue | null>(null)

let serial = 0

export function requestMatrixScreenContinue(roomId: string, text: string): void {
  serial += 1
  $matrixScreenContinue.set({ id: `${roomId}\u0000${serial}`, roomId, text })
}

/** Takes the request for `roomId`, at most once. */
export function takeMatrixScreenContinue(roomId: string): MatrixScreenContinue | null {
  const request = $matrixScreenContinue.get()

  if (!request || request.roomId !== roomId) {
    return null
  }

  $matrixScreenContinue.set(null)

  return request
}
