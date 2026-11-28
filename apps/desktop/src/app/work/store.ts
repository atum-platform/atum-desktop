import { atom } from 'nanostores'

import type { MatrixWorkBridge, MatrixWorkProjection } from '../../../shared/matrix-work'

/** Main's projection of Work on this Mac. `undefined`: not read yet; `null`: no Work for this account here. */
export const $work = atom<MatrixWorkProjection | null | undefined>(undefined)

/** The Work page is the rail's current place. */
export const $workActive = atom(false)

/**
 * Follow main's projection. Returns the unsubscribe. A bridge that is missing or whose read fails means
 * Work is not on this build: the rail draws no entry (gated like the other rail places).
 */
export function connectWorkBridge(bridge: MatrixWorkBridge | undefined): () => void {
  if (!bridge) {
    $work.set(null)

    return () => {}
  }

  let live = true

  const unsubscribe = bridge.subscribe(projection => {
    if (live) {
      $work.set(projection)
    }
  })

  bridge.read().then(
    projection => {
      if (live) {
        $work.set(projection)
      }
    },
    () => {
      if (live) {
        $work.set(null)
      }
    }
  )

  return () => {
    live = false
    unsubscribe()
  }
}

/** Leaving Work for another rail place, or Work going away: the page closes and the view leaves the window. */
export function setWorkActive(active: boolean): void {
  $workActive.set(active)
}

/** The rail draws Work only while main says this account has it. */
export function workOnRail(projection: MatrixWorkProjection | null | undefined): boolean {
  return Boolean(projection)
}

export function resetWorkStoreForTests(): void {
  $work.set(undefined)
  $workActive.set(false)
}
