import type { MatrixMessage, MatrixRoom } from '../../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../../shared/matrix-assistant-room'
import type { MatrixPetIntentProjection } from '../../../shared/matrix-pet-intent'
import { parseMatrixPetIntents } from '../../../shared/matrix-pet-intent'
import type { PetCommand } from '../../../shared/pet-engine/types'

export interface PetIntentMessage extends MatrixMessage {
  petIntents?: MatrixPetIntentProjection
}

export interface PetIntakeInput {
  room: MatrixRoom
  message: PetIntentMessage
  now: number
  shown: boolean
  reducedMotion: boolean
}

/** One account/agent lifetime. Only cosmetic commands leave this boundary. */
export function createPetIntentIntake() {
  const applied = new Map<string, true>()
  let lastAppliedAt: number | undefined

  return {
    accept({ room, message, now, shown, reducedMotion }: PetIntakeInput): readonly PetCommand[] | undefined {
      const projected = message.petIntents
      // Revalidate the native projection too: never trust an arbitrary renderer shape.
      const commands = parseMatrixPetIntents({ v: 1, intents: projected?.commands })

      if (
        !commands ||
        projected?.live !== true ||
        !Number.isFinite(now) ||
        room.membership !== 'join' ||
        !room.assistant ||
        !room.direct ||
        !(room.encrypted || room.plainAgent) ||
        !room.agentPrincipal ||
        // The agent's own chat (typed, as every agent chat is since 0.20, or a legacy untyped one);
        // any other room type is refused.
        (room.roomType && room.roomType !== MATRIX_ASSISTANT_ROOM_TYPE) ||
        room.appGroup ||
        message.sender !== room.agentPrincipal ||
        !message.id.startsWith('$') ||
        // As its room sends it: plain only in a plain room, never plaintext in an encrypted one.
        (room.encrypted && !message.encrypted) ||
        message.decryptionFailed ||
        message.own ||
        message.pending ||
        message.failed ||
        message.redacted ||
        message.edited ||
        message.notice ||
        message.attachment ||
        !Number.isFinite(message.timestamp) ||
        now - message.timestamp > 60_000 ||
        message.timestamp - now > 30_000 ||
        applied.has(message.id)
      ) {
        return undefined
      }

      applied.set(message.id, true)

      if (applied.size > 500) {
        applied.delete(applied.keys().next().value!)
      }

      // An eligible live message that was hidden/reduced/rate-limited is consumed,
      // rather than replayed when the display preference or another snapshot changes.
      if (!shown || reducedMotion || (lastAppliedAt !== undefined && now - lastAppliedAt < 20_000)) {
        return undefined
      }

      lastAppliedAt = now

      return commands
    }
  }
}
