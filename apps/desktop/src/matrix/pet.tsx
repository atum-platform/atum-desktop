import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixPetDisplayBridge } from '../../shared/matrix-pet-display'

import { AgentPet } from './pet/agent-pet'
import { matrixPetRoom } from './pet/room'

export interface MatrixAgentPetProps {
  snapshot: MatrixSnapshot
  onSettings?: () => void
  onStore?: () => void
  display?: MatrixPetDisplayBridge
}

/** Feature-local cosmetic state. The keyed child drops every previous account/
 * agent request, choice and canvas before rendering the newly selected agent. */
export function MatrixAgentPet({ snapshot, onSettings, onStore, display }: MatrixAgentPetProps) {
  const room = matrixPetRoom(snapshot, snapshot.roomId)
  const bridge = window.atumMatrix.pets

  if (!room || !bridge || !snapshot.petScope) {
    return null
  }

  return (
    <AgentPet
      agent={room.agentPrincipal}
      bridge={bridge}
      display={display}
      key={`${snapshot.petScope}:${room.agentPrincipal}`}
      onSettings={onSettings}
      onStore={onStore}
      scope={snapshot.petScope}
      snapshot={snapshot}
    />
  )
}
