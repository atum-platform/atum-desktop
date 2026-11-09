import { useEffect, useState } from 'react'

import type { MatrixSnapshot } from '../../../shared/matrix'
import type { PetSignals } from '../../../shared/pet-engine/types'

import { petWorkChangesAt, petWorkFor } from './presentation'

/** The room's work signal for the companion, re-read when it changes on its own (a fresh
 * failure's short reaction ending) even if no new snapshot arrives. */
export function usePetWork(snapshot: MatrixSnapshot): PetSignals['work'] {
  const [, setTick] = useState(0)
  const now = Date.now()
  const work = petWorkFor(snapshot, now)
  const changesAt = petWorkChangesAt(snapshot, now)

  useEffect(() => {
    if (changesAt === null) {
      return
    }

    const timer = setTimeout(() => setTick(tick => tick + 1), Math.max(0, changesAt - Date.now()) + 50)

    return () => clearTimeout(timer)
  }, [changesAt])

  return work
}
