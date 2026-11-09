import { useEffect, useState } from 'react'

import type { MatrixDriveBridge, MatrixDriveView } from '../../shared/matrix-drive'

/**
 * Drive is "unavailable" when this build ships no Drive engine (or nobody is signed
 * in). Every other state — even disconnected or needing attention — has a page worth
 * opening; that one has nothing to offer, so it gets no destination at all.
 */
export function matrixDriveAvailable(view: Pick<MatrixDriveView, 'state'> | null | undefined): boolean {
  return Boolean(view && view.state !== 'unavailable')
}

/**
 * Whether the rail should offer Drive. Starts false so a build without Drive never
 * flashes a rail item that then disappears; the newest native view wins.
 */
export function useMatrixDriveAvailable(bridge: MatrixDriveBridge | undefined): boolean {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    setAvailable(false)

    if (!bridge) {
      return
    }

    let live = true
    let revision = -1

    const receive = (view: MatrixDriveView) => {
      if (live && view.revision >= revision) {
        revision = view.revision
        setAvailable(matrixDriveAvailable(view))
      }
    }

    const unsubscribe = bridge.subscribe(receive)
    void bridge
      .read()
      .then(receive)
      .catch(() => {})

    return () => {
      live = false
      unsubscribe()
    }
  }, [bridge])

  return available
}
