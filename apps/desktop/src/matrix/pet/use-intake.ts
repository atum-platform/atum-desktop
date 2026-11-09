import { useEffect, useRef } from 'react'

import type { MatrixSnapshot } from '../../../shared/matrix'
import { MATRIX_PET_INTENT_PLAYBACK } from '../../../shared/matrix-pet-intent'

import { holdPetPresentation } from './store'

/** Feed only validated cosmetic commands into the already mounted engine surface. */
export function usePetIntentIntake(
  snapshot: MatrixSnapshot,
  shown: boolean,
  reducedMotion: boolean,
  enabled: boolean = MATRIX_PET_INTENT_PLAYBACK
) {
  const room = snapshot.rooms.find(value => value.id === snapshot.roomId)
  const principal = JSON.stringify([snapshot.petScope, room?.agentPrincipal])
  const held = useRef<ReturnType<typeof holdPetPresentation> | undefined>(undefined)

  const active =
    enabled && Boolean(snapshot.identity && snapshot.petScope && room?.agentPrincipal && snapshot.state === 'ready')

  useEffect(() => {
    if (!active) {
      return
    }

    const presentation = holdPetPresentation(principal, performance.now())
    held.current = presentation

    return () => {
      held.current = undefined
      presentation.release()
    }
  }, [active, principal])

  useEffect(() => {
    const presentation = held.current

    if (!presentation || !room) {
      return
    }

    for (const message of snapshot.messages) {
      const commands = presentation.intake.accept({ room, message, now: Date.now(), shown, reducedMotion })

      if (commands) {
        const current = presentation.store.get()
        presentation.store.set({ ...current, lastActiveAt: performance.now(), commands })
      }
    }
  }, [active, principal, reducedMotion, room, shown, snapshot.messages])
}
