import { atom } from 'nanostores'
import { useEffect } from 'react'

import type { MatrixMessageLinkTarget } from '../../../shared/matrix-message-link'

export interface MatrixMessageLinkRequest {
  serial: number
  target: MatrixMessageLinkTarget
}

let serial = 0

/** One foreground navigation intent. Membership and event truth are checked only by its opener. */
export const $matrixMessageLinkRequest = atom<MatrixMessageLinkRequest | null>(null)

export function requestMatrixMessageLink(target: MatrixMessageLinkTarget): MatrixMessageLinkRequest {
  const request = { serial: ++serial, target }
  $matrixMessageLinkRequest.set(request)

  return request
}

/** Retire only the request the async opener actually handled. */
export function clearMatrixMessageLinkRequest(request: MatrixMessageLinkRequest): void {
  if ($matrixMessageLinkRequest.get() === request) {
    $matrixMessageLinkRequest.set(null)
  }
}

/** Install the narrow native message-link delivery seam once in the Matrix renderer. */
export function useMatrixMessageLinkBridge(): void {
  useEffect(() => {
    const bridge = window.atumMatrix.messageLinks
    if (!bridge) {return}
    let live = true
    let liveTarget: string | undefined
    const key = (target: MatrixMessageLinkTarget) => JSON.stringify(target)
    const receive = (target: MatrixMessageLinkTarget) => {
      if (live) {
        liveTarget = key(target)
        requestMatrixMessageLink(target)
      }
    }
    const unsubscribe = bridge.subscribe(receive)
    void bridge.takePending().then(target => {
      if (target && key(target) !== liveTarget) {receive(target)}
    }).catch(() => {})

    return () => {
      live = false
      unsubscribe()
    }
  }, [])
}
